const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

// An answer the host really sent, as opposed to a transport failure:
// `respond(async () => rejected(409))` makes the stubbed fetch report a status.
function rejected(status, body = {}) {
  return { __status: status, __body: body };
}

async function bridge(options = {}) {
  const location = new URL(
    `https://host.example/h5p-editor-core/editor/new${options.search || ''}`
  );
  const moduleUrl = 'https://host.example/h5p-editor-core/web/editor-host.js';
  const source = fs
    .readFileSync(path.join(__dirname, '../web/editor-host.js'), 'utf8')
    .replace('import.meta.url', JSON.stringify(moduleUrl));
  const notifications = [];
  const requests = [];
  const reads = [];
  let listener;
  const iframeListeners = {};
  let serialize = (submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    });
  let saveResponse = async () => ({
    contentId: '7',
    savedBytes: 10,
    deltaBytes: 10
  });
  let revision = 'rev-1';
  const parent = {
    postMessage(message) {
      notifications.push(message);
    }
  };
  const element = { setAttribute() {}, appendChild() {}, remove() {} };
  const window = {
    parent,
    H5P: { jQuery: {} },
    H5PEditor: {
      Editor: function (_library, _params, _mount, onIframeLoaded) {
        this.getContent = (...args) => serialize(...args);
        // The editor calls back with the form iframe's window as `this`.
        onIframeLoaded?.call({
          H5PEditor: {},
          document: {
            addEventListener(type, fn) {
              iframeListeners[type] = fn;
            }
          }
        });
      }
    },
    addEventListener(_type, handler) {
      listener = handler;
    }
  };
  // The bridge is served as an ES module; it must never gain import/export
  // statements or top-level await, which a classic vm script cannot parse.
  // Timers are looked up on the test's global at call time so node:test's
  // mock timers apply; real ones are unref'd so a pending watchdog cannot
  // hold the runner open.
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location,
    window,
    // The page needs a source of randomness for the save's idempotency key.
    // `crypto.randomUUID` exists only in a secure context, so the bridge must
    // work with the getRandomValues-only object too (`options.crypto`).
    crypto: 'crypto' in options ? options.crypto : nodeCrypto.webcrypto,
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      if (typeof id?.unref === 'function') id.unref();
      return id;
    },
    clearTimeout: (id) => clearTimeout(id),
    document: {
      getElementById: () => ({ ...element }),
      createElement: () => ({ ...element })
    },
    async fetch(url, options) {
      if (options?.method === 'PATCH') {
        requests.push({
          url,
          body: JSON.parse(options.body),
          headers: options.headers
        });
        const value = await saveResponse();
        if (value?.__status) {
          return {
            ok: false,
            status: value.__status,
            text: async () => JSON.stringify(value.__body)
          };
        }
        return { ok: true, text: async () => JSON.stringify(value) };
      }
      reads.push(String(url));
      // Only stored content has a revision; `new` has nothing to match yet.
      const stored = !String(url).includes('/content/new/');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            ...(stored ? { revision } : {}),
            h5p: {
              integration: { editor: { assets: {} } },
              styles: [],
              scripts: []
            }
          })
      };
    }
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  if (options.expectReady !== false) {
    assert.equal(notifications[0]?.type, 'ready');
  }
  return {
    requests,
    notifications,
    reads,
    save(origin = location.origin, from = parent) {
      listener({
        origin,
        source: from,
        data: { source: 'editor-embedder', type: 'save' }
      });
    },
    serialize(fn) {
      serialize = fn;
    },
    edit(type = 'input') {
      iframeListeners[type]?.({ type });
    },
    respond(fn) {
      saveResponse = fn;
    },
    stored(next) {
      revision = next;
    },
    tick: () => new Promise((resolve) => setImmediate(resolve))
  };
}

test('repeated save messages cannot create duplicate content while a save is pending', async () => {
  const host = await bridge();
  const pending = Promise.withResolvers();
  host.respond(() => pending.promise);
  host.save();
  host.save();
  assert.equal(host.requests.length, 1);
  assert.equal(
    host.notifications.filter((message) => message.type === 'saving').length,
    2,
    'the duplicate is answered with saving rather than dropped silently'
  );
  pending.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.match(host.requests[0].url, /content\/new$/);
  assert.match(host.requests[1].url, /content\/7$/);
});

test('validation errors, runtime exceptions and failed requests all allow a retry', async () => {
  const host = await bridge();
  host.serialize((_submit, error) => error('missing-title'));
  host.save();
  host.serialize(() => {
    throw new Error('runtime failure');
  });
  host.save();
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    })
  );
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  await host.tick();
  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(
    host.notifications.filter((message) => message.type === 'error').length,
    3
  );
});

test('a save the editor never answers times out, and its late callback cannot save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  let lateSubmit;
  host.serialize((submit) => {
    lateSubmit = submit;
  });
  host.save();
  t.mock.timers.tick(59_999);
  assert.equal(host.notifications.at(-1).type, 'saving');
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /did not respond/);
  lateSubmit({
    library: 'H5P.Column 1.18',
    params: '{"params":{},"metadata":{}}'
  });
  await host.tick();
  assert.equal(
    host.requests.length,
    0,
    'an abandoned attempt must not create content'
  );
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    })
  );
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 1);
  assert.equal(host.notifications.at(-1).type, 'saved');
});

// The vendored runtime stringifies params on the upgrade path as well
// (h5p-content-upgrade-process.js); the object form is tolerated, not relied on.
test('a params object is accepted as well as the serialized string', async () => {
  const host = await bridge();
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: { params: { text: 'upgraded' }, metadata: { title: 'Book' } }
    })
  );
  host.save();
  await host.tick();
  assert.deepEqual(host.requests[0].body, {
    library: 'H5P.Column 1.18',
    params: { text: 'upgraded' },
    metadata: { title: 'Book' }
  });
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('save messages from another origin or window are ignored', async () => {
  const host = await bridge();
  host.save('https://stranger.example');
  host.save('https://host.example', {});
  await host.tick();
  assert.equal(host.requests.length, 0);
});

test('a present but unparseable parentOrigin refuses to run rather than post to the wrong window', async () => {
  const host = await bridge({
    search: '?parentOrigin=not-a-valid-origin',
    expectReady: false
  });
  // Nothing was posted anywhere: with no valid parent the bridge must not fall
  // back to this page's own origin and aim `ready`/`error` at the wrong window.
  assert.equal(
    host.notifications.length,
    0,
    'no postMessage is sent when the parent origin is invalid'
  );
  // And a save message — even one that names this page's own origin — cannot
  // drive a write, because the frame never loaded an editor.
  host.save('https://host.example');
  await host.tick();
  assert.equal(host.requests.length, 0);
});

test('a save the host never answers times out and can be retried; its late answer is then ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const first = Promise.withResolvers();
  host.respond(() => first.promise);
  host.save();
  t.mock.timers.tick(119_999);
  host.save();
  assert.equal(host.requests.length, 1, 'still pending: no second request');
  assert.equal(host.notifications.at(-1).type, 'saving');
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /did not answer/);
  const second = Promise.withResolvers();
  host.respond(() => second.promise);
  host.save();
  assert.equal(
    host.requests.length,
    2,
    'a retry is possible after the timeout'
  );
  assert.match(host.requests[1].url, /content\/new$/);
  // The superseded attempt's answer must not disturb the newer save.
  first.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saving');
  second.resolve({ contentId: '8', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '8');
  host.respond(async () => ({ contentId: '8' }));
  host.save();
  await host.tick();
  assert.match(host.requests[2].url, /content\/8$/);
});

test('a late answer to a timed-out save is adopted while no newer save has started', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const late = Promise.withResolvers();
  host.respond(() => late.promise);
  host.save();
  t.mock.timers.tick(120_000);
  assert.equal(host.notifications.at(-1).type, 'error');
  late.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '7');
  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.match(
    host.requests[1].url,
    /content\/7$/,
    'the adopted id is updated, not created again'
  );
});

test('input in the editor is reported once as `changed`, cleared by a save, and re-reported after it', async () => {
  const host = await bridge();
  const changes = () =>
    host.notifications.filter((message) => message.type === 'changed');
  assert.equal(changes().length, 0, 'a freshly opened editor is not dirty');
  host.edit('input');
  host.edit('change');
  host.edit('input');
  assert.equal(changes().length, 1, 'one report per dirty period');
  assert.equal(changes()[0].contentId, 'new');

  const pending = Promise.withResolvers();
  host.respond(() => pending.promise);
  host.save();
  host.edit('input');
  assert.equal(changes().length, 1, 'an edit during a save is held back');
  pending.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  const types = host.notifications.map((message) => message.type);
  assert.deepEqual(
    types.slice(-2),
    ['saved', 'changed'],
    'the held-back edit follows the save'
  );
  assert.equal(changes()[1].contentId, '7');

  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  host.edit('input');
  assert.equal(
    changes().length,
    3,
    'a save clears the flag so the next edit is reported again'
  );
});

test('a failed save keeps the dirty state and does not report it twice', async () => {
  const host = await bridge();
  host.edit('input');
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  host.edit('input');
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

// --- Contract version 3: idempotency key, revision matching, operation id ---

test('the saved DTO carries the operation id the parent acknowledges, keyed idempotently', async () => {
  const host = await bridge();
  host.respond(async () => ({
    contentId: '7',
    operationId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    revision: 'rev-9',
    savedBytes: 10,
    deltaBytes: 10
  }));
  host.save();
  await host.tick();
  const saved = host.notifications.at(-1);
  assert.equal(saved.type, 'saved');
  assert.equal(saved.operationId, '1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.match(
    host.requests[0].headers['idempotency-key'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
});

test('the idempotency key is generated without crypto.randomUUID', async () => {
  const v4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // A plain-http page outside localhost has no secure context, so
  // `crypto.randomUUID` is missing even though `crypto` itself is there.
  const insecure = await bridge({
    crypto: { getRandomValues: (bytes) => bytes.fill(7) }
  });
  insecure.save();
  await insecure.tick();
  assert.match(insecure.requests[0].headers['idempotency-key'], v4);

  // And with no Web Crypto at all the key is still a well-formed v4.
  const bare = await bridge({ crypto: undefined });
  bare.save();
  await bare.tick();
  assert.match(bare.requests[0].headers['idempotency-key'], v4);
});

test('a body the host definitively rejected is dropped, not replayed for ever', async () => {
  const host = await bridge();
  host.respond(async () =>
    rejected(422, { error: 'H5P.Video is not supported here.' })
  );
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /not supported/);

  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{"text":"second"},"metadata":{}}'
    })
  );
  host.respond(async () => ({ contentId: '7', savedBytes: 5, deltaBytes: 5 }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2, 'the rejected body is not sent again');
  assert.deepEqual(host.requests[1].body.params, { text: 'second' });
  assert.notEqual(
    host.requests[1].headers['idempotency-key'],
    host.requests[0].headers['idempotency-key'],
    'a new attempt is a new operation'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('an ambiguous save is replayed under its own key before newer input is sent', async () => {
  const host = await bridge();
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');

  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{"text":"second"},"metadata":{}}'
    })
  );
  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-1',
    savedBytes: 5,
    deltaBytes: 5
  }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 3);
  assert.equal(
    host.requests[1].headers['idempotency-key'],
    host.requests[0].headers['idempotency-key'],
    'the attempt whose outcome is unknown is replayed, not repeated as a new one'
  );
  assert.deepEqual(host.requests[1].body.params, {});
  assert.match(host.requests[1].url, /content\/new$/);
  assert.deepEqual(host.requests[2].body.params, { text: 'second' });
  assert.match(
    host.requests[2].url,
    /content\/7$/,
    'the id the replay resolved is used'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('a conflict preserves the authored revision so retry cannot overwrite unseen changes', async () => {
  const host = await bridge();
  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-1',
    savedBytes: 5,
    deltaBytes: 5
  }));
  host.save();
  await host.tick();
  assert.equal(
    host.requests[0].headers['if-match'],
    undefined,
    'a new item matches nothing'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');

  // Another window saved in the meantime.
  host.stored('rev-2');
  host.respond(async () =>
    rejected(409, { error: 'This content was changed in another editor.' })
  );
  host.save();
  await host.tick();
  assert.equal(host.requests[1].headers['if-match'], 'rev-1');
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.ok(
    !host.reads.some((url) => /content\/7\/edit$/.test(url)),
    'a conflict cannot silently adopt an unseen revision'
  );

  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-3',
    savedBytes: 6,
    deltaBytes: 1
  }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 3, 'the conflicting body is not replayed');
  assert.equal(
    host.requests[2].headers['if-match'],
    'rev-1',
    'the host still rejects overwriting an unseen revision'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('superseded recovery cannot submit its old body after a newer attempt starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  const edit = (text) =>
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: JSON.stringify({ params: { text }, metadata: {} })
      })
    );
  edit('A');
  host.save();
  t.mock.timers.tick(120001);
  edit('B');
  host.save();
  t.mock.timers.tick(120001);
  edit('C');
  host.save();
  deferred[2].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.deepEqual(
    host.requests.map((r) => r.body.params.text),
    ['A', 'A', 'A', 'C']
  );
  deferred[1].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.equal(host.requests.length, 4, 'the superseded B must not be sent');
  deferred[3].resolve({
    contentId: '7',
    revision: 'rev-C',
    operationId: 'op-C'
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).operationId, 'op-C');
  deferred[0].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).operationId, 'op-C');
});

test('an obsolete HTTP rejection cannot discard the current ambiguous operation key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  host.save();
  t.mock.timers.tick(120001);
  host.save();
  const key = host.requests[1].headers['idempotency-key'];
  deferred[0].resolve(rejected(409));
  await host.tick();
  t.mock.timers.tick(120001);
  host.save();
  assert.equal(host.requests[2].headers['idempotency-key'], key);
  deferred[2].resolve({ contentId: '7', revision: 'rev-A' });
  deferred[1].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
});

test('a recovery answered after its attempt was superseded still resolves the id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  const edit = (text) =>
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: JSON.stringify({ params: { text }, metadata: {} })
      })
    );
  edit('A');
  host.save();
  t.mock.timers.tick(120001);
  edit('B');
  host.save();
  assert.equal(host.requests.length, 2, 'B first replays the ambiguous A');
  t.mock.timers.tick(120001);
  // The third attempt is still inside the editor's serialization when the
  // replay finally answers, so it has not yet looked at the pending operation.
  let lateSubmit;
  host.serialize((submit) => {
    lateSubmit = submit;
  });
  host.save();
  const key = host.requests[1].headers['idempotency-key'];
  deferred[1].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
  lateSubmit({
    library: 'H5P.Column 1.18',
    params: JSON.stringify({ params: { text: 'C' }, metadata: {} })
  });
  await host.tick();
  assert.equal(
    host.requests[2].headers['idempotency-key'],
    key,
    'the settled key is replayed rather than a new item created'
  );
  deferred[2].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
  assert.equal(host.requests.length, 4);
  assert.match(
    host.requests[3].url,
    /content\/7$/,
    'the recovered id is used instead of a second /content/new'
  );
  assert.deepEqual(host.requests[3].body.params, { text: 'C' });
  deferred[3].resolve({ contentId: '7', revision: 'rev-C' });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '7');
});
