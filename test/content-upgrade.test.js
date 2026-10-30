const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mixedUpgradeVersions } = require('./fixtures/upgrade-libraries');

// Run the complete vendored editor helper file, including its actual loadJs
// cache and upgradeContent wrapper, with local script transport and seeded
// library data. Unlike the bridge harness, this exercises the save-time loader.
function editorRuntime(options) {
  const loads = [];
  const dialogs = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    console,
    navigator: { userAgent: 'node' },
    parent: {
      H5PEditor: { t: (_namespace, key) => key },
      H5PIntegration: options.editModel.h5p.integration
    },
    H5P: {
      jQuery: {
        extend: (_deep, target, ...sources) => Object.assign(target, ...sources)
      },
      jsLoaded: (src) => context.H5PIntegration.loadedJs.includes(src),
      ConfirmationDialog: function (options) {
        dialogs.push(options);
        this.appendTo = () => this;
        this.show = () => {};
      }
    },
    document: {
      body: {},
      createElement: () => ({}),
      head: {
        appendChild(script) {
          loads.push(script.src);
          setImmediate(() => {
            const source = options.scripts[script.src];
            if (source === undefined) {
              script.onerror(new Error('Script not found'));
              return;
            }
            vm.runInContext(source, context, { filename: script.src });
            script.onload();
          });
        }
      }
    }
  });
  context.window = context;
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../assets/h5p/editor/scripts/h5peditor.js'),
      'utf8'
    ),
    context
  );
  vm.runInContext(
    `ns.libraryCache = ${JSON.stringify(options.libraries)};`,
    context
  );
  return {
    loads,
    dialogs,
    context,
    upgrade() {
      return new Promise((resolve, reject) => {
        context.ns.upgradeContent(
          new context.ns.ContentType('H5P.Book 1.0'),
          new context.ns.ContentType('H5P.Book 1.2'),
          {
            params: options.editModel.h5p.params,
            metadata: options.editModel.h5p.metadata
          },
          (error, result) =>
            error ? reject(error) : resolve(JSON.parse(result))
        );
      });
    }
  };
}

for (const middle of [
  'unchanged-leaf',
  'unchanged-container',
  'upgraded-leaf',
  'no-script',
  'mutating-script',
  'mutating-wrapper'
]) {
  test(`the editor keeps version-specific upgrade hooks with ${middle}`, async () => {
    const runtime = editorRuntime(mixedUpgradeVersions(middle));
    const result = await runtime.upgrade();
    const { params } = result;
    assert.deepEqual(params.first.params.steps, ['new 1.1', 'new 1.2']);
    assert.deepEqual(params.last, params.first);
    assert.equal(params.last.library, 'H5P.Item 1.2');
    assert.equal(params.last.metadata.migrated, true);
    assert.deepEqual(
      params.middle.params.steps,
      ['upgraded-leaf', 'mutating-script', 'mutating-wrapper'].includes(middle)
        ? ['old 1.1']
        : undefined
    );
    if (middle === 'unchanged-container') {
      assert.equal(params.middle.params.child.library, 'H5P.Text 1.1');
    }
    const loads = [...runtime.loads];
    assert.equal(loads.filter((url) => url.includes('H5P.Item-1.2')).length, 1);
    // Another save in the same iframe must work with ns.loadJs's cache too.
    assert.deepEqual(await runtime.upgrade(), result);
    assert.deepEqual(runtime.loads, loads);
    assert.deepEqual(runtime.dialogs, []);
  });
}

test('the editor retries a failed upgrade script request', async () => {
  const options = mixedUpgradeVersions();
  const url = '/h5p/libraries/H5P.Item-1.1/upgrades.js';
  const source = options.scripts[url];
  delete options.scripts[url];
  const runtime = editorRuntime(options);
  await assert.rejects(runtime.upgrade(), (error) => {
    assert.match(error, /Error loading upgrades H5P.Item/);
    return true;
  });
  assert.equal(runtime.dialogs.length, 1);
  options.scripts[url] = source;
  const { params } = await runtime.upgrade();
  assert.deepEqual(params.last.params.steps, ['new 1.1', 'new 1.2']);
  assert.equal(runtime.loads.filter((loaded) => loaded === url).length, 2);
});

test('the editor fails, rather than waits, when the core cannot snapshot hooks', async () => {
  // An older core cached under the same URL has no getUpgradeHooks. Without
  // the failure the save would wait for the host's timeout, and so would every
  // later upgrade in the iframe that needs the same script.
  const options = mixedUpgradeVersions();
  options.scripts['/h5p/core/js/h5p-content-upgrade-process.js?v=1'] +=
    '\ndelete H5P.ContentUpgradeProcess.getUpgradeHooks;';
  const runtime = editorRuntime(options);
  for (const attempt of [1, 2]) {
    await assert.rejects(runtime.upgrade(), (error) => {
      assert.match(error.message, /getUpgradeHooks is not a function/);
      return true;
    });
    assert.equal(runtime.dialogs.length, attempt);
  }
});

test('the core keeps the global fallback for an upstream loader without snapshots', async () => {
  const runtime = editorRuntime(mixedUpgradeVersions());
  await runtime.upgrade();
  const { context } = runtime;
  vm.runInContext(
    `
    H5PUpgrades['H5P.Legacy'] = {1: {1: function (params, done) {
      params.migrated = true;
      done(null, params);
    }}};
  `,
    context
  );
  const result = await new Promise((resolve, reject) => {
    new context.H5P.ContentUpgradeProcess(
      'H5P.Legacy',
      new context.H5P.Version('1.0'),
      new context.H5P.Version('1.1'),
      '{"params":{},"metadata":{}}',
      1,
      (_name, _version, done) =>
        done(null, {
          name: 'H5P.Legacy',
          semantics: [],
          upgradesScript: '/legacy/upgrades.js'
        }),
      (error, result) => (error ? reject(error) : resolve(JSON.parse(result)))
    );
  });
  assert.equal(result.params.migrated, true);
});
