import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Generated wasm bindings are not ours to lint.
  { ignores: ['dist', 'src/wasm'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The curated accessibility set: the rules that pin exactly what the
      // panels' aria pass did, and no more. `no-autofocus` is deliberately off
      // (the dialogs autofocus their filename boxes) and so is
      // `click-events-have-key-events` (the mobile drawer scrim is a
      // mouse-only full-screen dismiss with no keyboard role).
      //
      // `control-has-associated-label` needs the recommended config's
      // ignoreElements: the app's form controls get their names from wrapping
      // `<label>`s (pinned by `label-has-associated-control`), which the rule
      // cannot see, so it must ignore inputs/selects/textareas and keep its
      // teeth for buttons, where a bare `title` alone does not satisfy it.
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/control-has-associated-label': [
        'error',
        {
          ignoreElements: ['audio', 'canvas', 'embed', 'input', 'select', 'textarea', 'tr', 'video'],
          ignoreRoles: [
            'grid',
            'listbox',
            'menu',
            'menubar',
            'radiogroup',
            'row',
            'tablist',
            'toolbar',
            'tree',
            'treegrid',
          ],
        },
      ],
      'jsx-a11y/label-has-associated-control': 'error',
    },
  },
);
