👻 Handling AI Hallucinations with GitHub Copilot

When AI confidently makes things up — and how to protect yourself.

⚠️ Common Hallucinations to Watch For
When using GitHub Copilot, be alert to the following types of hallucinations:

Functions that don't exist — Copilot may suggest methods that were never real or have been renamed in newer versions.
Wrong API method signatures — Parameter order, types, or return values might be incorrect.
Deprecated library features — Suggestions may reference APIs from older library versions that no longer work.
Made-up npm packages — Always verify package names on npmjs.com before installing.
Incorrect documentation links — Never follow Copilot-generated URLs without independently verifying them first.

🛡️ How to Protect Yourself
Apply these habits every time you use Copilot:

Always test AI-generated code

Don't commit code without running it first.
Write unit tests to validate Copilot's suggestions behave as expected.

Verify functions exist in the official docs

Hover over suggested methods in your IDE to confirm they exist.
Cross-reference with the library's official documentation.

Check library versions

Copilot's training data may be outdated.
Confirm the suggested API matches your project's installed version (check package.json or requirements.txt).

Don't trust import statements blindly

Verify that the imported module actually exports what Copilot claims.
Check for typos in package names — malicious lookalike packages exist.

Use TypeScript for early warnings

TypeScript gives compile-time errors when Copilot invents non-existent properties or methods.
This catches hallucinations before they reach runtime.

💡 Remember

AI doesn't "know" it's wrong — it just predicts likely tokens.

Copilot has no awareness of whether the code it generates actually works. It predicts what looks correct based on patterns in its training data.
Treat every Copilot suggestion like code from a junior developer:

Review it carefully.
Test it thoroughly.
Verify it against real documentation.

## Architecture Rules

Refer to [../.github/architecture_rules.md](../architecture_rules.md) for project architecture rules and guidance. Paste the original `architecture_rules.md` content into that file and link to specific rules in PR descriptions to simplify reviews.
