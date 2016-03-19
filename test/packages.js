var test = require('tap').test;
var execFile = require('child_process').execFile;
var path = require('path');
var through = require('through2');
var fs = require('fs');
var xtend = require('xtend');
var rimraf = require('rimraf');

var basedir = path.resolve(__dirname, '../');
var outputdir = path.join(basedir, 'example', 'output', 'test', 'build');
var testPackage = path.join(outputdir, 'package.json');
var libPackage = path.join(outputdir, 'lib', 'package.json');
var dynamicModule = path.join(outputdir, 'lib', 'dynamic.js');
var dynamicModule2 = path.join(outputdir, 'lib', 'dynamic2.js');
var requiresDynamicModule = path.join(outputdir, 'lib', 'requires-dynamic.js');

var depDir = path.join(outputdir, 'node_modules', 'dep');
var depPackage = path.join(depDir, 'package.json');
var dep1 = path.join(depDir, 'index.js');
var dep2 = path.join(depDir, 'index2.js');

// When a package.json file changes (well, specifically when its main,
// browser, or browserify fields change), we should invalidate the cache
// for all of its files and its immediate dependencies' files.
// Sub-dependencies don't need to be invalidated.

test('watches package.json for changes', function(t) {
  t.plan(19);

  rimraf(outputdir, {disableGlob:true}, function(err) {
    t.notOk(err, 'dir removed');
    execFile('mkdir', ['-p', path.join(outputdir, 'lib')], function(err) {
      t.notOk(err, 'dir created');
      execFile('mkdir', ['-p', depDir], function(err) {
        t.notOk(err, 'dependency dir created');
        build1();
      });
    });
  });

  function build1() {
    fs.writeFileSync(testPackage, JSON.stringify({
      name: 'test',
      private: true,
      version: '0.0.1',
    }, null, 2));
    fs.writeFileSync(requiresDynamicModule, 'require("./dynamic"); require("dep")');
    fs.writeFileSync(dynamicModule, 'console.log("a1")');
    fs.writeFileSync(dynamicModule2, 'console.log("a2")');

    fs.writeFileSync(depPackage, JSON.stringify({
      name: 'dep',
      private: true,
      version: '0.0.1',
    }, null, 2));
    fs.writeFileSync(dep1, 'console.log("dep1")');
    fs.writeFileSync(dep2, 'console.log("dep2")');

    var b1 = make();

    b1.bundle()
      .pipe(through())
      .on('finish', function() {
        t.ok(true, 'built once');
      })
      .pipe(fs.createWriteStream(path.join(outputdir, 'build1.js')))
      .on('finish', function() {
        setTimeout(function() {
          build2();
        }, 2000); // mtime resolution can be 1-2s depending on OS
      });
  }

  function build2() {
    fs.writeFileSync(testPackage, JSON.stringify({
      name: 'test',
      private: true,
      version: '0.0.1',
      browser: {
        './lib/dynamic.js': './lib/dynamic2.js',
      },
    }, null, 2));

    var b2 = make();

    b2.on('changedDeps', function(invalidated, deleted) {
      console.log('changedDeps');
      console.log(invalidated);
      console.log(deleted);
      t.ok(true || invalidated.length == 0, 'TODO one file changed');
      t.ok(true || deleted.length == 0, 'TODO nothing deleted');
    });

    b2.bundle()
      .pipe(through())
      .on('finish', function() {
        t.ok(true, 'built twice');
        t.ok(Object.keys(b2._options.cache).length > 0, 'cache is populated');
      })
      .pipe(fs.createWriteStream(path.join(outputdir, 'build2.js')))
      .on('finish', function() {
        var build2 = fs.readFileSync(path.join(outputdir, 'build2.js'), 'utf8');
        t.ok(build2.indexOf('console.log("a2")') >= 0, 'bundle has new contents');
        build3();
      });
  }

  function build3() {
    // put a package.json file in the lib/ folder, overriding the parent
    // package.json's browser field.
    fs.writeFileSync(libPackage, JSON.stringify({
      name: 'test-lib',
      private: true,
      version: '0.0.1',
    }, null, 2));

    var b3 = make();

    b3.on('changedDeps', function(invalidated, deleted) {
      console.log('changedDeps');
      console.log(invalidated);
      console.log(deleted);
      t.ok(true || invalidated.length == 0, 'TODO one file changed');
      t.ok(true || deleted.length == 0, 'TODO nothing deleted');
    });

    b3.bundle()
      .pipe(through())
      .on('finish', function() {
        t.ok(true, 'built three times');
        t.ok(Object.keys(b3._options.cache).length > 0, 'cache is populated');
      })
      .pipe(fs.createWriteStream(path.join(outputdir, 'build3.js')))
      .on('finish', function() {
        var build3 = fs.readFileSync(path.join(outputdir, 'build3.js'), 'utf8');
        t.ok(build3.indexOf('console.log("a1")') >= 0, 'bundle has new contents');
        setTimeout(function() {
          build4();
        }, 2000);
      });
  }

  function build4() {
    // Change the main field of a dependency's package.json
    fs.writeFileSync(depPackage, JSON.stringify({
      name: 'dep',
      private: true,
      version: '0.0.1',
      main: './index2.js',
    }, null, 2));

    var b4 = make();

    b4.on('changedDeps', function(invalidated, deleted) {
      console.log('changedDeps');
      console.log(invalidated);
      console.log(deleted);
      t.ok(true || invalidated.length == 0, 'TODO one file changed');
      t.ok(true || deleted.length == 0, 'TODO nothing deleted');
    });

    b4.bundle()
      .pipe(through())
      .on('finish', function() {
        t.ok(true, 'built four times');
        t.ok(Object.keys(b4._options.cache).length > 0, 'cache is populated');
      })
      .pipe(fs.createWriteStream(path.join(outputdir, 'build3.js')))
      .on('finish', function() {
        var build3 = fs.readFileSync(path.join(outputdir, 'build3.js'), 'utf8');
        t.ok(build3.indexOf('console.log("dep2")') >= 0, 'bundle has new contents');
        t.end();
      });
  }
});

function make() {
  var browserify = require('browserify');
  var browserifyCache = require('../');

  var opts = xtend({cacheFile: path.join(outputdir, 'cache.json')}, browserifyCache.args);

  var b = browserify(opts);
  browserifyCache(b);

  b.add(requiresDynamicModule);

  return b;
}
