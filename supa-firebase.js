/* =====================================================================
   supa-firebase.js — Firebase (API "compat") rodando em cima do Supabase

   O app (cliente, chamada e painel) foi escrito com a API do Firestore:
   db.collection('x').doc('y').onSnapshot(...), runTransaction, batch,
   FieldValue.increment, firebase.auth()... Este arquivo recria essa mesma
   API usando o Supabase por baixo, então nenhuma tela precisou ser
   reescrita.

   Como os dados ficam guardados:
     tabela public.fs_docs (col, id, data jsonb, version)
   Leitura:  RLS (listas) e RPC fs_get (1 documento)
   Escrita:  RPC fs_commit — aplica as regras de segurança no servidor e
             resolve increment/arrayUnion/... de forma atômica.
   Tempo real: Supabase Realtime (postgres_changes) + atualização periódica
             como rede de segurança.

   Precisa do supabase-js (UMD) carregado antes:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/dist/umd/supabase.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  var TABLE = 'fs_docs';
  var PAGE = 1000;                 // máximo de linhas por requisição do PostgREST
  var CACHE_COLS = { store: true }; // docs guardados no aparelho p/ abrir offline
  var POLL_COLS = { orders: true, cupons: true }; // docs que o cliente só lê por id

  var client = null;
  var apps = {};

  /* ---------------- utilidades ---------------- */
  function FirebaseError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    e.name = 'FirebaseError';
    return e;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function autoId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    var arr = new Uint8Array(20);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    for (var i = 0; i < 20; i++) s += chars[arr[i] % chars.length];
    return s;
  }

  function limpar(obj) {
    // JSON: Timestamp/Date viram texto ISO, sentinelas viram {"__fv":...},
    // undefined some (o Firestore recusaria; aqui só ignoramos).
    return obj === undefined ? null : JSON.parse(JSON.stringify(obj));
  }

  function erroDoServidor(error) {
    var msg = String((error && (error.message || error.details)) || error || '');
    if (/permission-denied|row-level security|permission denied/i.test(msg))
      return FirebaseError('permission-denied', 'Missing or insufficient permissions.');
    if (/aborted/i.test(msg)) return FirebaseError('aborted', 'Transaction aborted.');
    if (/not-found/i.test(msg)) return FirebaseError('not-found', 'No document to update.');
    if (/invalid-argument/i.test(msg)) return FirebaseError('invalid-argument', 'Invalid argument.');
    if (/fetch|network|Load failed|NetworkError|timeout/i.test(msg))
      return FirebaseError('unavailable', 'Sem conexão com o servidor.');
    return FirebaseError('internal', msg || 'Erro interno.');
  }

  var cache = {
    ler: function (k) {
      try { var v = localStorage.getItem('fsc:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    salvar: function (k, v) {
      try { localStorage.setItem('fsc:' + k, JSON.stringify(v)); } catch (e) {}
    },
    apagar: function (k) {
      try { localStorage.removeItem('fsc:' + k); } catch (e) {}
    }
  };

  /* ---------------- Timestamp / FieldValue ---------------- */
  function Timestamp(ms) { this._ms = ms; }
  Timestamp.fromMillis = function (ms) { return new Timestamp(Number(ms)); };
  Timestamp.fromDate = function (d) { return new Timestamp(d.getTime()); };
  Timestamp.now = function () { return new Timestamp(Date.now()); };
  Timestamp.prototype.toMillis = function () { return this._ms; };
  Timestamp.prototype.toDate = function () { return new Date(this._ms); };
  Timestamp.prototype.toJSON = function () { return new Date(this._ms).toISOString(); };
  Timestamp.prototype.valueOf = function () { return this._ms; };
  Object.defineProperty(Timestamp.prototype, 'seconds', { get: function () { return Math.floor(this._ms / 1000); } });
  Object.defineProperty(Timestamp.prototype, 'nanoseconds', { get: function () { return (this._ms % 1000) * 1e6; } });

  function Sentinel(obj) { this._fv = obj; }
  Sentinel.prototype.toJSON = function () { return this._fv; };
  Sentinel.prototype.isEqual = function (o) { return o instanceof Sentinel && JSON.stringify(o._fv) === JSON.stringify(this._fv); };

  var FieldValue = {
    increment: function (n) { return new Sentinel({ __fv: 'increment', n: Number(n) || 0 }); },
    arrayUnion: function () { return new Sentinel({ __fv: 'arrayUnion', v: limpar(Array.prototype.slice.call(arguments)) }); },
    arrayRemove: function () { return new Sentinel({ __fv: 'arrayRemove', v: limpar(Array.prototype.slice.call(arguments)) }); },
    serverTimestamp: function () { return new Sentinel({ __fv: 'serverTimestamp' }); },
    delete: function () { return new Sentinel({ __fv: 'delete' }); }
  };

  /* ---------------- snapshots ---------------- */
  function DocumentSnapshot(ref, exists, data, version) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = !!exists;
    this._data = exists ? data : undefined;
    this._version = version;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  DocumentSnapshot.prototype.data = function () {
    return this.exists ? limpar(this._data) : undefined;
  };
  DocumentSnapshot.prototype.get = function (campo) {
    if (!this.exists) return undefined;
    return String(campo).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, this._data);
  };

  function QuerySnapshot(query, docs) {
    this.query = query;
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  QuerySnapshot.prototype.forEach = function (cb, thisArg) { this.docs.forEach(cb, thisArg); };
  QuerySnapshot.prototype.docChanges = function () {
    return this.docs.map(function (d, i) { return { type: 'added', doc: d, oldIndex: -1, newIndex: i }; });
  };

  /* ---------------- escrita ---------------- */
  function commit(writes, pre) {
    if (!writes.length) return Promise.resolve();
    return client.rpc('fs_commit', { p_writes: writes, p_pre: pre || [] }).then(function (res) {
      if (res.error) throw erroDoServidor(res.error);
      // atualiza na hora quem está ouvindo esses documentos (sem esperar o realtime)
      writes.forEach(function (w) {
        if (CACHE_COLS[w.col] && w.op === 'delete') cache.apagar(w.col + '/' + w.id);
        registry.tocar(w.col, w.id);
      });
      return undefined;
    }, function (e) { throw erroDoServidor(e); });
  }

  function montarWrite(ref, op, data, opts) {
    var w = { op: op, col: ref._col, id: ref.id };
    if (op !== 'delete') w.data = limpar(data || {});
    if (op === 'set' && opts && (opts.merge || opts.mergeFields)) w.merge = true;
    return w;
  }

  function lerDoc(ref) {
    return client.rpc('fs_get', { p_col: ref._col, p_id: ref.id }).then(function (res) {
      if (res.error) throw erroDoServidor(res.error);
      var r = res.data || {};
      if (CACHE_COLS[ref._col]) {
        if (r.exists) cache.salvar(ref.path, { data: r.data, version: r.version });
        else cache.apagar(ref.path);
      }
      return new DocumentSnapshot(ref, r.exists, r.data, r.version);
    }, function (e) { throw erroDoServidor(e); });
  }

  /* ---------------- consultas ---------------- */
  function caminhoJson(campo, texto) {
    var partes = String(campo).split('.');
    var ult = partes.pop();
    var base = 'data' + partes.map(function (p) { return '->' + p; }).join('');
    return base + (texto ? '->>' : '->') + ult;
  }

  function aplicarFiltro(q, f) {
    var v = f.value;
    if (v instanceof Timestamp || v instanceof Date) v = v.toJSON();
    var ops = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
    if (f.op === 'array-contains') return q.filter(caminhoJson(f.field, false), 'cs', JSON.stringify([v]));
    if (f.op === 'in') {
      var lista = (v || []).map(String);
      return q.in(caminhoJson(f.field, true), lista);
    }
    if (v === null) return f.op === '!=' ? q.not(caminhoJson(f.field, false), 'is', null) : q.is(caminhoJson(f.field, false), null);
    if (typeof v === 'string') return q.filter(caminhoJson(f.field, true), ops[f.op], v);
    return q.filter(caminhoJson(f.field, false), ops[f.op], JSON.stringify(v));
  }

  function rodarConsulta(query) {
    var total = query._limit;
    var resultado = [];
    function pagina(desde) {
      var q = client.from(TABLE).select('id,data,version').eq('col', query._col);
      query._filters.forEach(function (f) { q = aplicarFiltro(q, f); });
      if (query._orders.length) {
        query._orders.forEach(function (o) {
          q = q.order(caminhoJson(o.field, false), { ascending: o.dir !== 'desc', nullsFirst: false });
        });
      }
      q = q.order('id', { ascending: true });
      var quantos = total == null ? PAGE : Math.min(PAGE, total - resultado.length);
      q = q.range(desde, desde + quantos - 1);
      return q.then(function (res) {
        if (res.error) throw erroDoServidor(res.error);
        var linhas = res.data || [];
        resultado = resultado.concat(linhas);
        var acabou = linhas.length < quantos || (total != null && resultado.length >= total);
        return acabou ? resultado : pagina(desde + linhas.length);
      });
    }
    return pagina(0).then(function (linhas) {
      // Firestore não devolve documentos sem o campo usado no orderBy
      if (query._orders.length) {
        linhas = linhas.filter(function (l) {
          return query._orders.every(function (o) {
            return String(o.field).split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, l.data) !== undefined;
          });
        });
      }
      if (query._limitToLast) linhas = linhas.slice(-query._limitToLast);
      var col = new CollectionReference(query._col);
      return new QuerySnapshot(query, linhas.map(function (l) {
        return new DocumentSnapshot(col.doc(l.id), true, l.data, l.version);
      }));
    }, function (e) { throw e && e.code ? e : erroDoServidor(e); });
  }

  /* ---------------- ouvintes (tempo real) ---------------- */
  var registry = {
    lista: [],
    canal: null,
    add: function (l) {
      this.lista.push(l);
      this.garantirCanal();
      return l;
    },
    remove: function (l) {
      var i = this.lista.indexOf(l);
      if (i > -1) this.lista.splice(i, 1);
    },
    tocar: function (col, id) {
      this.lista.forEach(function (l) {
        if (l.col !== col) return;
        if (l.tipo === 'query' || l.id === id) l.agendar();
      });
    },
    tudo: function () { this.lista.forEach(function (l) { l.agendar(); }); },
    evento: function (payload) {
      var linha = (payload.new && payload.new.col) ? payload.new : payload.old;
      if (!linha || !linha.col) return;
      var apagado = payload.eventType === 'DELETE';
      this.lista.forEach(function (l) {
        if (l.col !== linha.col) return;
        if (l.tipo === 'doc') {
          if (l.id !== linha.id) return;
          if (apagado) l.emitirDoc(false, null, null);
          else if (payload.new && payload.new.data) l.emitirDoc(true, payload.new.data, payload.new.version);
          else l.agendar();
        } else {
          l.agendar();
        }
      });
    },
    garantirCanal: function () {
      if (this.canal || !client) return;
      var self = this;
      var primeiraVez = true;
      this.canal = client.channel('fs-docs-' + autoId().slice(0, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, function (p) { self.evento(p); })
        .subscribe(function (status) {
          if (status === 'SUBSCRIBED') {
            // reconectou: pode ter perdido eventos no meio do caminho
            if (!primeiraVez) self.tudo();
            primeiraVez = false;
          }
        });
    }
  };

  window.addEventListener('online', function () { registry.tudo(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') registry.tudo();
  });

  function normalizarObservador(args) {
    var a = Array.prototype.slice.call(args);
    if (a.length && typeof a[0] === 'object' && a[0] && typeof a[0].next !== 'function' && typeof a[1] === 'function') a.shift(); // options
    if (a.length && typeof a[0] === 'object' && a[0] && typeof a[0].next === 'function') {
      return { next: a[0].next.bind(a[0]), error: a[0].error ? a[0].error.bind(a[0]) : null };
    }
    return { next: a[0], error: a[1] || null };
  }

  function ouvirDoc(ref, obs) {
    var ativo = true;
    var ultimaVersao;       // undefined = nada emitido ainda
    var timer = null, poll = null, rodando = false, deNovo = false;

    var l = {
      tipo: 'doc', col: ref._col, id: ref.id,
      emitirDoc: function (existe, data, versao) {
        if (!ativo) return;
        var v = existe ? versao : null;
        if (ultimaVersao !== undefined && v === ultimaVersao) return;
        ultimaVersao = v;
        if (CACHE_COLS[ref._col]) {
          if (existe) cache.salvar(ref.path, { data: data, version: versao });
          else cache.apagar(ref.path);
        }
        try { obs.next(new DocumentSnapshot(ref, existe, data, versao)); } catch (e) { setTimeout(function () { throw e; }); }
      },
      agendar: function () {
        if (!ativo) return;
        clearTimeout(timer);
        timer = setTimeout(buscar, 60);
      }
    };

    function buscar() {
      if (!ativo) return;
      if (rodando) { deNovo = true; return; }
      rodando = true;
      client.rpc('fs_get', { p_col: ref._col, p_id: ref.id }).then(function (res) {
        rodando = false;
        if (res.error) {
          var err = erroDoServidor(res.error);
          if (err.code === 'permission-denied') {
            parar();
            if (obs.error) obs.error(err); else console.error(err);
          }
          return;
        }
        var r = res.data || {};
        l.emitirDoc(r.exists, r.data, r.version);
        if (deNovo) { deNovo = false; buscar(); }
      }, function () { rodando = false; });
    }

    function parar() {
      ativo = false;
      clearTimeout(timer);
      clearInterval(poll);
      registry.remove(l);
    }

    // abre na hora com a última cópia salva no aparelho (cardápio offline)
    if (CACHE_COLS[ref._col]) {
      var c = cache.ler(ref.path);
      if (c) setTimeout(function () { if (ultimaVersao === undefined) l.emitirDoc(true, c.data, c.version); }, 0);
    }

    registry.add(l);
    buscar();
    poll = setInterval(buscar, POLL_COLS[ref._col] ? 5000 : 30000);
    return parar;
  }

  function ouvirConsulta(query, obs) {
    var ativo = true;
    var assinatura = null;
    var timer = null, poll = null, rodando = false, deNovo = false;

    var l = {
      tipo: 'query', col: query._col,
      agendar: function () {
        if (!ativo) return;
        clearTimeout(timer);
        timer = setTimeout(buscar, 250);
      }
    };

    function buscar() {
      if (!ativo) return;
      if (rodando) { deNovo = true; return; }
      rodando = true;
      rodarConsulta(query).then(function (snap) {
        rodando = false;
        if (!ativo) return;
        var ass = snap.docs.map(function (d) { return d.id + ':' + d._version; }).join('|');
        if (ass !== assinatura) {
          assinatura = ass;
          try { obs.next(snap); } catch (e) { setTimeout(function () { throw e; }); }
        }
        if (deNovo) { deNovo = false; buscar(); }
      }, function (err) {
        rodando = false;
        if (err && err.code === 'permission-denied') {
          parar();
          if (obs.error) obs.error(err); else console.error(err);
        }
      });
    }

    function parar() {
      ativo = false;
      clearTimeout(timer);
      clearInterval(poll);
      registry.remove(l);
    }

    registry.add(l);
    buscar();
    poll = setInterval(buscar, 15000);
    return parar;
  }

  /* ---------------- referências ---------------- */
  function Query(col, filters, orders, limit, limitToLast) {
    this._col = col;
    this._filters = filters || [];
    this._orders = orders || [];
    this._limit = limit;
    this._limitToLast = limitToLast;
  }
  Query.prototype._clone = function (mud) {
    var q = new Query(this._col, this._filters.slice(), this._orders.slice(), this._limit, this._limitToLast);
    mud(q);
    return q;
  };
  Query.prototype.where = function (field, op, value) {
    return this._clone(function (q) { q._filters.push({ field: String(field), op: op, value: value }); });
  };
  Query.prototype.orderBy = function (field, dir) {
    return this._clone(function (q) { q._orders.push({ field: String(field), dir: dir || 'asc' }); });
  };
  Query.prototype.limit = function (n) {
    return this._clone(function (q) { q._limit = n; });
  };
  Query.prototype.limitToLast = function (n) {
    return this._clone(function (q) { q._limitToLast = n; });
  };
  Query.prototype.get = function () { return rodarConsulta(this); };
  Query.prototype.onSnapshot = function () { return ouvirConsulta(this, normalizarObservador(arguments)); };

  function CollectionReference(col) {
    Query.call(this, col);
    this.id = col;
    this.path = col;
  }
  CollectionReference.prototype = Object.create(Query.prototype);
  CollectionReference.prototype.constructor = CollectionReference;
  CollectionReference.prototype.doc = function (id) {
    return new DocumentReference(this._col, id == null ? autoId() : String(id));
  };
  CollectionReference.prototype.add = function (data) {
    var ref = this.doc();
    return ref.set(data).then(function () { return ref; });
  };

  function DocumentReference(col, id) {
    this._col = col;
    this.id = id;
    this.path = col + '/' + id;
  }
  Object.defineProperty(DocumentReference.prototype, 'parent', {
    get: function () { return new CollectionReference(this._col); }
  });
  DocumentReference.prototype.get = function () {
    var ref = this;
    return lerDoc(ref).catch(function (e) {
      if (e.code === 'unavailable' && CACHE_COLS[ref._col]) {
        var c = cache.ler(ref.path);
        if (c) { var s = new DocumentSnapshot(ref, true, c.data, c.version); s.metadata.fromCache = true; return s; }
      }
      throw e;
    });
  };
  DocumentReference.prototype.set = function (data, opts) { return commit([montarWrite(this, 'set', data, opts)]); };
  DocumentReference.prototype.update = function (data) {
    if (typeof data === 'string') {           // update('campo', valor, 'campo2', valor2)
      var obj = {};
      for (var i = 0; i < arguments.length; i += 2) obj[arguments[i]] = arguments[i + 1];
      data = obj;
    }
    return commit([montarWrite(this, 'update', data)]);
  };
  DocumentReference.prototype.delete = function () { return commit([montarWrite(this, 'delete')]); };
  DocumentReference.prototype.onSnapshot = function () { return ouvirDoc(this, normalizarObservador(arguments)); };
  DocumentReference.prototype.isEqual = function (o) { return o && o.path === this.path; };

  /* ---------------- lote e transação ---------------- */
  function WriteBatch() { this._writes = []; }
  WriteBatch.prototype.set = function (ref, data, opts) { this._writes.push(montarWrite(ref, 'set', data, opts)); return this; };
  WriteBatch.prototype.update = function (ref, data) { this._writes.push(montarWrite(ref, 'update', data)); return this; };
  WriteBatch.prototype.delete = function (ref) { this._writes.push(montarWrite(ref, 'delete')); return this; };
  WriteBatch.prototype.commit = function () { return commit(this._writes); };

  function Transaction() { this._writes = []; this._reads = []; }
  Transaction.prototype.get = function (ref) {
    var self = this;
    return lerDoc(ref).then(function (snap) {
      self._reads.push({ col: ref._col, id: ref.id, version: snap.exists ? snap._version : null });
      return snap;
    });
  };
  Transaction.prototype.set = WriteBatch.prototype.set;
  Transaction.prototype.update = WriteBatch.prototype.update;
  Transaction.prototype.delete = WriteBatch.prototype.delete;

  function Firestore() {}
  Firestore.prototype.collection = function (path) {
    var partes = String(path).split('/');
    return new CollectionReference(partes[partes.length - 1]);
  };
  Firestore.prototype.doc = function (path) {
    var p = String(path).split('/');
    return new DocumentReference(p[0], p.slice(1).join('/'));
  };
  Firestore.prototype.batch = function () { return new WriteBatch(); };
  Firestore.prototype.runTransaction = function (fn) {
    var tentativa = 0;
    function rodar() {
      var tx = new Transaction();
      return Promise.resolve(fn(tx)).then(function (resultado) {
        return commit(tx._writes, tx._reads).then(function () { return resultado; });
      }).catch(function (e) {
        if (e && e.code === 'aborted' && tentativa < 5) {
          tentativa++;
          return sleep(40 * Math.pow(2, tentativa) + Math.random() * 50).then(rodar);
        }
        throw e;
      });
    }
    return rodar();
  };
  Firestore.prototype.enablePersistence = function () { return Promise.resolve(); };
  Firestore.prototype.settings = function () {};
  Firestore.prototype.enableNetwork = function () { registry.tudo(); return Promise.resolve(); };
  Firestore.prototype.disableNetwork = function () { return Promise.resolve(); };

  /* ---------------- autenticação ---------------- */
  function erroAuth(e) {
    var m = String((e && e.message) || e || '').toLowerCase();
    var code = 'auth/internal-error';
    if ((e && e.status === 429) || /rate limit|too many|security purposes/.test(m)) code = 'auth/too-many-requests';
    else if (/invalid login credentials|invalid credentials|email not confirmed/.test(m)) code = 'auth/invalid-credential';
    else if (/already (been )?registered|already exists|email_exists|user_already_exists/.test(m)) code = 'auth/email-already-in-use';
    else if (/password/.test(m) && /(at least|short|weak|characters)/.test(m)) code = 'auth/weak-password';
    else if (/email/.test(m) && /invalid|valid email/.test(m)) code = 'auth/invalid-email';
    else if (/banned|disabled/.test(m)) code = 'auth/user-disabled';
    else if (/fetch|network|load failed/.test(m)) code = 'auth/network-request-failed';
    var err = FirebaseError(code, (e && e.message) || code);
    return err;
  }

  function montarUsuario(u, auth) {
    if (!u) return null;
    return {
      uid: u.id,
      email: u.email || null,
      emailVerified: !!u.email_confirmed_at,
      displayName: (u.user_metadata && u.user_metadata.nome) || null,
      metadata: { creationTime: u.created_at, lastSignInTime: u.last_sign_in_at },
      getIdToken: function () {
        return client.auth.getSession().then(function (r) { return r.data.session ? r.data.session.access_token : null; });
      },
      reauthenticateWithCredential: function (cred) {
        return client.auth.signInWithPassword({ email: cred.email, password: cred.password }).then(function (r) {
          if (r.error) throw erroAuth(r.error);
          return { user: auth.currentUser };
        });
      },
      updatePassword: function (senha) {
        return client.auth.updateUser({ password: senha }).then(function (r) { if (r.error) throw erroAuth(r.error); });
      }
    };
  }

  function criarConta(email, senha) {
    return client.functions.invoke('criar-conta', { body: { email: email, password: senha } }).then(function (r) {
      if (r.error) {
        // o corpo da resposta traz a mensagem real
        var ctx = r.error.context;
        if (ctx && typeof ctx.json === 'function') {
          return ctx.json().then(function (b) { throw erroAuth({ message: (b && b.error) || r.error.message }); },
                                 function () { throw erroAuth(r.error); });
        }
        throw erroAuth(r.error);
      }
      if (r.data && r.data.error) throw erroAuth({ message: r.data.error });
      return r.data;
    });
  }

  function Auth(secundario) {
    this._secundario = !!secundario;
    this.currentUser = null;
    this._cbs = [];
    this._pronto = false;
    this._ultimoUid = undefined;
    if (!secundario) this._iniciar();
  }
  Auth.prototype._iniciar = function () {
    var self = this;
    client.auth.onAuthStateChange(function (evento, sessao) {
      var u = sessao && sessao.user ? montarUsuario(sessao.user, self) : null;
      if (u && self.currentUser && self.currentUser.uid === u.uid) u = self.currentUser;
      self.currentUser = u;
      self._pronto = true;
      var uid = u ? u.uid : null;
      if (evento === 'PASSWORD_RECOVERY') setTimeout(function () { self._recuperarSenha(); }, 300);
      // o supabase-js não deixa chamar o banco dentro deste callback —
      // por isso os avisos saem num setTimeout
      if (uid !== self._ultimoUid) {
        self._ultimoUid = uid;
        setTimeout(function () {
          self._cbs.slice().forEach(function (cb) { try { cb(self.currentUser); } catch (e) { setTimeout(function () { throw e; }); } });
          registry.tudo();
        }, 0);
      }
    });
  };
  Auth.prototype._recuperarSenha = function () {
    var nova = window.prompt('Digite a sua NOVA senha (mínimo 6 caracteres):');
    if (!nova) return;
    client.auth.updateUser({ password: nova }).then(function (r) {
      alert(r.error ? 'Não foi possível trocar a senha: ' + r.error.message : '✅ Senha alterada! Você já está conectado.');
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    });
  };
  Auth.prototype.onAuthStateChanged = function (next) {
    var self = this;
    var cb = typeof next === 'function' ? next : (next && next.next ? next.next.bind(next) : function () {});
    this._cbs.push(cb);
    if (this._pronto || this._secundario) setTimeout(function () { cb(self.currentUser); }, 0);
    return function () {
      var i = self._cbs.indexOf(cb);
      if (i > -1) self._cbs.splice(i, 1);
    };
  };
  Auth.prototype.onIdTokenChanged = Auth.prototype.onAuthStateChanged;
  Auth.prototype.signInWithEmailAndPassword = function (email, senha) {
    var self = this;
    return client.auth.signInWithPassword({ email: String(email || '').trim(), password: senha || '' }).then(function (r) {
      if (r.error) throw erroAuth(r.error);
      var u = montarUsuario(r.data.user, self);
      self.currentUser = u;
      return { user: u };
    }, function (e) { throw erroAuth(e); });
  };
  Auth.prototype.createUserWithEmailAndPassword = function (email, senha) {
    var self = this;
    email = String(email || '').trim();
    return criarConta(email, senha).then(function (dados) {
      if (self._secundario) {
        // painel criando conta de funcionário: não troca quem está logado
        return { user: { uid: dados.uid, email: dados.email } };
      }
      return self.signInWithEmailAndPassword(email, senha);
    });
  };
  Auth.prototype.sendPasswordResetEmail = function (email) {
    return client.auth.resetPasswordForEmail(String(email || '').trim(), {
      redirectTo: location.origin + location.pathname
    }).then(function (r) { if (r.error) throw erroAuth(r.error); });
  };
  Auth.prototype.signOut = function () {
    if (this._secundario) return Promise.resolve();
    var self = this;
    return client.auth.signOut().then(function () { self.currentUser = null; });
  };
  Auth.prototype.setPersistence = function () { return Promise.resolve(); };

  /* ---------------- firebase.* ---------------- */
  function App(nome, config) {
    this.name = nome;
    this.options = config;
    this._db = null;
    this._auth = null;
  }
  App.prototype.firestore = function () { return this._db || (this._db = new Firestore()); };
  App.prototype.auth = function () { return this._auth || (this._auth = new Auth(this.name !== '[DEFAULT]')); };

  var firebase = {
    initializeApp: function (config, nome) {
      nome = nome || '[DEFAULT]';
      if (!client) {
        if (!window.supabase || !window.supabase.createClient) throw new Error('supabase-js não carregou');
        client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          realtime: { params: { eventsPerSecond: 20 } }
        });
        firebase._client = client;
      }
      apps[nome] = apps[nome] || new App(nome, config);
      if (nome === '[DEFAULT]') apps[nome].auth(); // começa a ouvir a sessão desde já
      return apps[nome];
    },
    app: function (nome) { return apps[nome || '[DEFAULT]']; },
    get apps() { return Object.keys(apps).map(function (k) { return apps[k]; }); }
  };

  firebase.firestore = function () { return firebase.app().firestore(); };
  firebase.firestore.FieldValue = FieldValue;
  firebase.firestore.Timestamp = Timestamp;
  firebase.auth = function () { return firebase.app().auth(); };
  firebase.auth.EmailAuthProvider = {
    credential: function (email, password) { return { email: email, password: password }; }
  };

  window.firebase = firebase;
})();
