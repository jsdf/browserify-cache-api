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
// 'transform' event are used for invalidating cache
test('make sure it builds a valid bundle when using cache', function(t) {
  t.plan(11);

  testUtils.cleanupTestOutputDir((err) => {
    t.notOk(err, 'clean up test output dir');
    fs.writeFileSync(requiresDynamicModule, 'require("./dynamic")');
    build1();
  });

  function build1() {
    fs.writeFileSync(dynamicModule, 'console.log("a")');
    fs.writeFileSync(dependentFile, 'foobar1');

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

    b2.on('changedDeps', function(invalidated, deleted) {
      t.ok(invalidated && invalidated.length == 1, 'one file changed');
      t.ok(deleted && deleted.length == 0, 'nothing deleted');
    });

    b2.bundle()
      .pipe(through())
      .on('finish', () => {
        t.ok(true, 'built twice');
        t.ok(Object.keys(b2._options.cache).length > 0, 'cache is populated');
      })
      .pipe(fs.createWriteStream(path.join(testUtils.testOutputDir, 'build2.js')))
      .on('finish', () => {
        var build2 = fs.readFileSync(path.join(testUtils.testOutputDir, 'build2.js'), 'utf8');
        t.ok(build2.indexOf('console.log("b")') >= 0, 'bundle has new contents');

        testUtils.waitForMtimeTick(build3);
      });
  }

  function build3() {
    // dependentFile is changed
    fs.writeFileSync(dependentFile, 'foobar2');

    var b3 = configureBrowserify(testUtils.makeBrowserify());

    b3.on('changedDeps', function(invalidated, deleted) {
      t.ok(invalidated.length == 0, 'nothing changed');
      t.ok(deleted.length == 0, 'nothing deleted');
    });

    b3.bundle()
      .pipe(through())
      .pipe(fs.createWriteStream(path.join(testUtils.testOutputDir, 'build3.js')))
      .on('finish', () => {
        t.ok(true, 'built thrice');
        var build3 = fs.readFileSync(path.join(testUtils.testOutputDir, 'build3.js'), 'utf8');
        t.ok(build3.indexOf('foobar2') >= 0, 'bundle has new contents');
        t.end();
      });
  }
});

function configureBrowserify(b) {
  b.add(requiresDynamicModule);

  // Simulate a transform that includes "dependent.txt" in "dynamic.js"
  b.transform(function(file) {
    if (file != dynamicModule)
      return through();

    return through(function(chunk, enc, cb) {
      var combined = new Buffer(
        chunk.toString() + '\nconsole.log("dependent.txt:", ' +
        JSON.stringify(fs.readFileSync(dependentFile, 'utf8')) +
        ');\n'
      );
      this.push(combined);
      this.emit('file', dependentFile);
      cb();
    });
  });

  return b;
}
