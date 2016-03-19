var test = require('tap').test;
var path = require('path');
var through = require('through2');
var fs = require('fs');

var testUtils = require('../support/testUtils');
var requiresJsonEntry = path.join(testUtils.projectRoot, 'example/test-module/requiresJson.js');

test('it builds valid bundles which include json, when using cache', (t) => {
  t.plan(4);

  var firstBundleFile = path.join(testUtils.testOutputDir, 'build-requiresJson1.js');
  var secondBundleFile = path.join(testUtils.testOutputDir, 'build-requiresJson2.js');

  testUtils.cleanupTestOutputDir((err) => {
    t.notOk(err, 'clean up test output dir');

    doBuild(firstBundleFile, () => {
      t.ok(true, 'built once');

      doBuild(secondBundleFile, () => {
        t.ok(true, 'built twice');

        var output = fs.readFileSync(secondBundleFile, {encoding: 'utf8'});
        t.notMatch(output, 'module.exports=module.exports={', "doesn't append json prelude twice");
        t.end();
      });
    });
  });

  function doBuild(filepath, done) {
    var b = testUtils.makeBrowserify();
    b.add(requiresJsonEntry);

    b.bundle()
      .pipe(through())
      .pipe(fs.createWriteStream(filepath))
      .on('finish', () => {
        testUtils.waitForMtimeTick(done);
      });
  }
});

