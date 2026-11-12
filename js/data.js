// The cache now lives in firebase.js so every page gets it. This file only re-exports it.
export { col, one, clearCache } from "./firebase.js";
