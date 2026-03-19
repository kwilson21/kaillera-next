/**
 * sync-worker.js — Web Worker for off-thread state compression/decompression.
 * Keeps the main thread free during resync.
 */

self.onmessage = async function (e) {
  var msg = e.data;

  if (msg.type === 'compress') {
    try {
      var cs = new CompressionStream('gzip');
      var writer = cs.writable.getWriter();
      writer.write(msg.data);
      writer.close();
      var reader = cs.readable.getReader();
      var chunks = [];
      while (true) {
        var result = await reader.read();
        if (result.value) chunks.push(result.value);
        if (result.done) break;
      }
      var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
      var out = new Uint8Array(total);
      var offset = 0;
      for (var i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      self.postMessage({ type: 'compressed', data: out, frame: msg.frame }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
  }

  if (msg.type === 'decompress') {
    try {
      var ds = new DecompressionStream('gzip');
      var writer = ds.writable.getWriter();
      writer.write(msg.data);
      writer.close();
      var reader = ds.readable.getReader();
      var chunks = [];
      while (true) {
        var result = await reader.read();
        if (result.value) chunks.push(result.value);
        if (result.done) break;
      }
      var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
      var out = new Uint8Array(total);
      var offset = 0;
      for (var i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      self.postMessage({ type: 'decompressed', data: out, frame: msg.frame }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
  }
};
