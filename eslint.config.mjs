import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.eslintrc.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Bar Math.random in src/ — V8's PRNG is predictable and never
      // acceptable for OTPs, tokens, pickup/delivery codes, IDs, or any
      // security-sensitive randomness. Use `randomInt` / `randomBytes`
      // / `randomUUID` from `node:crypto` instead. If you genuinely need
      // non-security jitter (e.g. shuffling display order, dithering an
      // animation), disable this rule on the single line with a comment
      // explaining why it's non-security work.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is predictable (V8 xorshift128+). Use randomInt/randomBytes from node:crypto for any security-sensitive randomness. See CONTRIBUTING.md.',
        },
      ],
    },
  },
  {
    // Allow Math.random inside test files — fixtures don't need crypto entropy.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
