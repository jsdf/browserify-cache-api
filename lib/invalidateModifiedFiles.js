var fs = require('fs');
var async = require('async');

var CONCURRENCY_LIMIT = 40;

function invalidateModifiedFiles(mtimes, files, invalidate, defer, done) {
  var invalidated = [];
  var deleted = [];
  async.eachLimit(files, CONCURRENCY_LIMIT, function(file, fileDone) {
    fs.stat(file, function(err, stat) {
      if (err) {
        // If the cache doesn't have any modification times it's a stream
        if (!mtimes[file] && defer) {
          if (defer(file)) {
            invalidated.push(file)
          }
        } else {
          deleted.push(file);
        }
        return fileDone();
      }
      var mtimeNew = stat.mtime.getTime();
      if (!(mtimes[file] && mtimeNew && mtimeNew == mtimes[file])) {
        invalidate(file);
        invalidated.push(file);
      }
      mtimes[file] = mtimeNew;
      fileDone();
    });
  }, function() {
    done(null, invalidated, deleted);
  });
}

module.exports = invalidateModifiedFiles;
