// Starts a test's stand-in server and waits until it listens.
//
// `new Promise((r) => server.listen(port, host, r))` never settles when the
// port is taken (EADDRINUSE goes to the server's "error" event, not the
// callback), so the test file stalls in its before hook forever instead of
// failing. This rejects with the error instead.

/**
 * @param {import("node:net").Server} server
 * @param {number} port 0 for any free port.
 * @param {string} [host]
 * @returns {Promise<number>} The port it listens on.
 */
export function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(new Error(`stand-in server could not listen on ${host}:${port}: ${err.message}`, { cause: err }));
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      resolve(server.address().port);
    });
  });
}
