var test = require('tap').test;
var path = require('path');
var through = require('through2');
var fs = require('fs');

var testUtils = require('../support/testUtils');

var mainEntry = path.join(testUtils.testOutputDir, 'index.js');
var aJs = path.join(testUtils.testOutputDir, 'a.js');
var bJs = path.join(testUtils.testOutputDir, 'b.js');

test('it handles de-duped modules correctly', (t) => {
  t.plan(5);

  testUtils.cleanupTestOutputDir((err) => {
    t.notOk(err, 'clean up test output dir');

    fs.writeFileSync(mainEntry, 'require("./a"); require("./b");');
    fs.writeFileSync(aJs, 'console.log("foo123");');
    fs.writeFileSync(bJs, 'console.log("foo123");');

    var build1 = path.join(testUtils.testOutputDir, 'build1.js');
    var build2 = path.join(testUtils.testOutputDir, 'build2.js');

    doBuild(build1, () => {
      t.ok(true, 'built once');

      var matches = fs.readFileSync(build1, 'utf8').match(/foo123/g);
      t.ok(matches && matches.length === 1, 'bundle has correct de-duped contents');

      fs.writeFileSync(aJs, 'console.log("foo456");');

      doBuild(build2, () => {
        t.ok(true, 'built twice');

        var matches = fs.readFileSync(build2, 'utf8').match(/foo456/g);
        t.ok(matches && matches.length === 1, 'bundle has updated un-de-duped contents');

        t.end();
      });
    });
  });

  function doBuild(filepath, done) {
    var b = testUtils.makeBrowserify();
    b.add(mainEntry);

    b.bundle()
      .pipe(through())
      .pipe(fs.createWriteStream(filepath))
      .on('finish', () => {
        testUtils.waitForMtimeTick(done);
      });
  }
});
