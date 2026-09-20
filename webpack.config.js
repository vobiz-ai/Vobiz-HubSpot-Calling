const path = require('path');

/*
 * The bundle is emitted next to source/index.html on purpose, so that one
 * directory is a complete, servable widget. Previously it went to bin/ while
 * the documented widget URL pointed at hubspot-app/index.html — a page whose
 * <script src="demo-minimal-js.bundle.js"> resolved to nothing.
 */
module.exports = {
  entry: './source/index.js',
  output: {
    filename: 'demo-minimal-js.bundle.js',
    path: path.resolve(__dirname, 'source'),
  },
  mode: 'development',
};
