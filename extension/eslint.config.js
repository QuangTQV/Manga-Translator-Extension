import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      // The codebase's existing convention for "unused but required" params
      // (e.g. parseChapterHTML's _pageUrl, kept for signature consistency
      // with its one call site) and for stripLegacyProviderFields'
      // destructure-to-discard pattern in shared/types.ts — an underscore
      // prefix marks it as deliberately unused, not dead code to flag.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
);
