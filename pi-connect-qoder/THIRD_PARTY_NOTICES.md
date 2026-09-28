# Third-party notices

This package is a **Pi coding agent port** of the DeepSeek Harness plugin
`@eghrhegpe/dsh-connect-qoder`. The port reuses the upstream plugin's protocol
modules (credential reading, loopback shim, COSY upstream client, catalog
handling) under the terms of its MIT license.

## Upstream plugin

- Package: `@eghrhegpe/dsh-connect-qoder` v0.3.2
- Author: eghrhegpe
- License: MIT
- Repository: https://github.com/eghrhegpe/dsh-connect-qoder
- Upstream of that fork: https://github.com/hdhgsysh/dsh-connect-qoder

The files under `lib/` are copies of the upstream plugin's dependency-free
modules (`credentials.js`, `upstream.js`, `shim.js`, `catalog-entry.js`,
`catalog-store.js`, `pi-model.js`, `offpeak.js`, `errors.js`,
`credential-cache.js`, `volatile.js`, `preferences.js`, `single-flight.js`,
`time.js`, `claim.js`, `http-utils.js`, `account-state.js`).

Local changes to those copies are limited to:

- `lib/shim.js`: `server.unref()` added so the in-process loopback endpoint can
  never hold a session-less Pi invocation open.

## License text

MIT License

Copyright (c) eghrhegpe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Trademarks

Qoder is a trademark of its respective owner. This project is not affiliated
with Qoder or DeepSeek. It only drives the user's own signed-in account on the
user's own machine and is intended for personal study and research.
