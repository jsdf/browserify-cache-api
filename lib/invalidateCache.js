var assertExists = require('./assertExists');
var invalidateModifiedFiles = require('./invalidateModifiedFiles');

function invalidateCache(b, mtimes, cache, done) {
  assertExists(mtimes);

  invalidateModifiedFiles(mtimes, Object.keys(cache), function(file) {
    delete cache[file];
  }, function (file) {
    return invalidateModifiedStream(b, cache, file)
  }, function(err, invalidated, deleted) {
    if (deferedQueue.length > 0) {
      b.on('_ready', function () {
        invalidated = invalidated.concat(deferedQueue.filter(function (file) {
          return invalidateModifiedStream(b, cache, file)
        }))
        done(err, invalidated, deleted)
      })

      return
    }

    done(err, invalidated, deleted)
  });
}

var deferedQueue = [];
function invalidateModifiedStream(b, cache, file) {
  if (b._pending > 0) {
    deferedQueue.push(file);
    return false;
  }

  var record = b._recorded.find(function (record) {
    return record.file == file;
  })

  if (cache[file].source != record.source) {
    delete cache[file];
    return true;
  }

  return false;
}

module.exports = invalidateCache;
