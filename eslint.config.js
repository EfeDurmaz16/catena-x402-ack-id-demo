import eslint from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["node_modules", "dist", ".pr-review"] },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" }
      ]
    }
  }
)
