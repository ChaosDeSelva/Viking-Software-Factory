import root from "../eslint.config.js";

// Examples are consumers: they may use only the public SDK entry points.
export default [
  ...root,
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@brokkr/*", "!@brokkr/sdk", "!@brokkr/sdk/testing", "../../packages/*"],
              message: "Examples consume Brokkr only through @brokkr/sdk and @brokkr/sdk/testing.",
            },
          ],
        },
      ],
    },
  },
];
