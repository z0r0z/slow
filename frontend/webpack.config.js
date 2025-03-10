const path = require("path");
const webpack = require("webpack");
const dotenv = require("dotenv");

// Load environment variables from .env file
const env = dotenv.config().parsed || {};

module.exports = {
  entry: "./src/index.js",
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  resolve: {
    fallback: {
      path: require.resolve("path-browserify"),
      process: require.resolve("process/browser"),
      buffer: require.resolve("buffer/"),
      assert: false,
      crypto: false,
      http: false,
      https: false,
      os: false,
      stream: false,
      util: false,
    },
    alias: {
      process: "process/browser",
    },
    modules: [path.resolve(__dirname, 'node_modules')],
  },
  experiments: {
    asyncWebAssembly: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.m?js/,
        resolve: {
          fullySpecified: false,
        },
      },
    ],
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: "process/browser",
      Buffer: ["buffer", "Buffer"],
    }),
    new webpack.DefinePlugin({
      'process.env': JSON.stringify({...process.env, ...env})
    }),
  ],
  devServer: {
    historyApiFallback: true,
    static: [
      { 
        directory: path.join(__dirname, "/"),
        publicPath: '/', 
      },
      {
        directory: path.join(__dirname, "public"),
        publicPath: '/',
      }
    ],
    port: 9000,
    hot: true,
    devMiddleware: {
      writeToDisk: true,
    },
  },
  optimization: {
    runtimeChunk: "single",
  },
};
