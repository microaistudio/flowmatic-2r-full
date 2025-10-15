module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:promise/recommended',
    'plugin:import/recommended',
    'plugin:node/recommended',
    'prettier'
  ],
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  rules: {
    'no-console': 'off',
    'node/no-unsupported-features/es-syntax': 'off',
    'import/no-unresolved': 'off',
    'promise/always-return': 'off',
    'promise/no-nesting': 'off'
  }
};
