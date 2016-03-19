var test = require('tap').test;
var path = require('path');
var through = require('through2');
var fs = require('fs');

var testUtils = require('../support/testUtils');

var dynamicModule = path.join(testUtils.testOutputDir, 'dynamic.js');
var requiresDynamicModule = path.join(testUtils.testOutputDir, 'requires-dynamic.js');
var dependentFile = path.join(testUtils.testOutputDir, 'dependent.txt');

// TODO: break this into a multiple tests
// currently it tests that cache is used, and also that dependencies from the
// 'transform' event are used for invalidating cache (incomplete)
test('make sure it builds a valid bundle when using cache', function(t) {
  t.plan(7);

  testUtils.cleanupTestOutputDir((err) => {
    t.notOk(err, 'clean up test output dir');

    t.notOk(err, 'dir created');
    fs.writeFileSync(requiresDynamicModule, 'require("./dynamic")');
    build1();
  });

  function build1() {
    fs.writeFileSync(dynamicModule, 'console.log("a")');

    var b1 = configureBrowserify(testUtils.makeBrowserify());

    b1.bundle()
      .pipe(through())
      .on('finish', () => {
        t.ok(true, 'built once');
      })
      .pipe(fs.createWriteStream(path.join(testUtils.testOutputDir, 'build1.js')))
      .on('finish', () => {
        testUtils.waitForMtimeTick(build2);
      });
  }

  function build2() {
    fs.writeFileSync(dynamicModule, 'console.log("b")');

    var b2 = configureBrowserify(testUtils.makeBrowserify());

    b2.on('changedDeps', function(invalidated) {
      t.ok(invalidated && invalidated.length == 1, 'one file changed');
    });

    b2.bundle()
      .pipe(through())
      .on('finish', () => {
        t.ok(true, 'built twice');
        t.ok(Object.keys(b2._options.cache).length > 0, 'cache is populated');
      })
      .pipe(fs.createWriteStream(path.join(testUtils.testOutputDir, 'build2.js')))
      .on('finish', () => {
        testUtils.waitForMtimeTick(build3);
      });
  }

  function build3() {
    // dependentFile is changed
    fs.writeFileSync(dependentFile, 'hello');

    var b3 = configureBrowserify(testUtils.makeBrowserify());

    b3.bundle()
      .pipe(through())
      .on('finish', () => {
        t.ok(true, 'built thrice');
        // TODO: add assertion that dynamicModule was invalidated
        t.end();
      })
      .pipe(fs.createWriteStream(path.join(testUtils.testOutputDir, 'build3.js')));
  }
});

function configureBrowserify(b) {
  b.add(requiresDynamicModule);

  // Simulate a transform that includes "dependent.txt" in "dynamic.js"
  b.transform(function(file) {
    if (file != dynamicModule)
      return through();

    return through(function(chunk, enc, cb) {
      this.push(chunk);
      this.emit('file', dependentFile);
      cb();
    });
  });

  return b;
}
