var test = require('tap').test
var exec = require('child_process').exec
var path = require('path')
var through = require('through2')
var fs = require('fs')
var xtend = require('xtend')

var basedir = path.resolve(__dirname, '../')
var outputdir = path.join(basedir, 'example','output','test','build')
var dynamicModule = path.join(outputdir, 'dynamic.js')
var requiresDynamicModule = path.join(outputdir, 'requires-dynamic.js')
var dependentFile = path.join(outputdir, 'dependent.txt')

test("make sure it builds and builds again", function (t) {
  // t.plan(5)
  exec('mkdir -p '+outputdir, function (err) {
    t.notOk(err, 'dir created')
    fs.writeFileSync(requiresDynamicModule, 'require("./dynamic")')
    build1()
  })

  function build1 () {
    fs.writeFileSync(dynamicModule, 'console.log("a")')

    var b1 = make()

    b1.bundle()
      .pipe(through())
      .on('finish', function () {
        t.ok(true, 'built once')
      })
      .pipe(fs.createWriteStream(path.join(outputdir,'build1.js')))
      .on('finish', function () {
        setTimeout(function () {
          build2()
        }, 2000) // mtime resolution can be 1-2s depending on OS
      })
  }

  function build2 () {
    fs.writeFileSync(dynamicModule, 'console.log("b")')

    var b2 = make()

    b2.on('changedDeps', function (invalidated, deleted) {
      t.ok(invalidated && invalidated.length == 1, 'one file changed')
    })

    b2.bundle()
      .pipe(through())
      .on('finish', function () {
        t.ok(true, 'built twice')
        t.ok(Object.keys(b2._options.cache).length > 0, 'cache is populated')
      })
      .pipe(fs.createWriteStream(path.join(outputdir,'build2.js')))
      .on('finish', function () {
        setTimeout(function () {
          build3()
        }, 2000) // mtime resolution can be 1-2s depending on OS
      })
  }

  function build3 () {
    // dependentFile is changed
    fs.writeFileSync(dependentFile, 'hello')

    var b3 = make()

    // TODO Not sure how to assert that dynamicModule was invalidated

    b3.bundle()
      .pipe(through())
      .on('finish', function () {
        t.ok(true, 'built thrice')
        t.end()
      })
      .pipe(fs.createWriteStream(path.join(outputdir,'build3.js')))
  }
})

function make () {
  var browserify = require('browserify')
  var browserifyCache = require('../')

  var opts = xtend({cacheFile: path.join(outputdir,'cache.json')}, browserifyCache.args)

  var b = browserify(opts)
  browserifyCache(b)

  b.add(requiresDynamicModule)

  // Simulate a transform that includes "dependent.txt" in "dynamic.js"
  b.transform(function(file, opts) {
    if (file != dynamicModule)
      return through();

    return through(function(chunk, enc, cb) {
      this.push(chunk);
      this.emit('file', dependentFile);
      cb();
    });
  })

  return b
}
