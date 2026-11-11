import { describe, expect, it } from "vitest";
import { parseScript, parseShell, parseShellWords, SUBSTITUTION_PLACEHOLDER } from "./shell.js";

const opaque = (src: string) => parseScript(src).opaque;
const argv = (src: string) => parseShell(src);

describe("parseShellWords", () => {
  it("keeps the resolution flag of each word", () => {
    expect(parseShellWords("echo $X 'a*' b*")).toEqual([
      [
        { text: "echo", unresolved: false },
        { text: "$X", unresolved: true },
        { text: "a*", unresolved: false },
        { text: "b*", unresolved: true },
      ],
    ]);
  });
});

describe("fail-closed constructs", () => {
  it.each([
    ["deep nesting", `${"$(".repeat(18)}x${")".repeat(18)}`, "nesting too deep"],
    ["<& to a word", "cat <&file", "unknown redirection <&word"],
    ["redirection right after a redirection", "cat > < x", "redirection without target"],
    ["redirection at the end", "echo x >", "redirection without target"],
    ["&> after a pending redirection", "echo > &> x", "redirection without target"],
    ["&> followed by < or >", "echo &>>> x", "unknown redirection"],
    ["&>< form", "echo &>< x", "unknown redirection"],
    ["process substitution with >(", "tee >(cat)", "process substitution"],
    ["unterminated ${", "echo ${X", "unterminated ${"],
    ["complex ${}", "echo ${X:-y}", "complex parameter expansion"],
    ["$[ ]", "echo $[1+1]", "$[ ] arithmetic"],
    ["arithmetic with names", "echo $((x+1))", "arithmetic expansion with names or substitutions"],
    ["malformed arithmetic", "echo $((1) )", "malformed arithmetic expansion"],
    [
      "case in a substitution",
      "echo $(case x in x) y;; esac)",
      "case or here-document inside command substitution",
    ],
    ["unterminated substitution", "echo $(ls", "unterminated substitution"],
    ["unterminated single quote in a substitution", "echo $(echo 'x)", "unterminated single quote"],
    ["unterminated double quote in a substitution", 'echo $(echo "x)', "unterminated double quote"],
    ["unterminated backtick", "echo `ls", "unterminated backtick"],
    ["unterminated $'", "echo $'abc", "unterminated $'...'"],
    ["unterminated $' ending in a backslash", "echo $'abc\\", "unterminated $'...'"],
    ["unterminated here-document", "cat <<EOF\nbody", "unterminated here-document"],
    ["here-document operator without a body line", "cat <<EOF", "unterminated here-document"],
    ["arithmetic command", "(( x = 1 ))", "arithmetic command (( ))"],
    ["named fd", "exec {fd}>x", "named file-descriptor redirection"],
  ])("%s", (_name, src, reason) => {
    expect(opaque(src)).toBe(reason);
  });
});

describe("words and operators", () => {
  it("joins a backslash-newline continuation and keeps an escaped character", () => {
    expect(argv("ec\\\nho a\\ b")).toEqual([["echo", "a b"]]);
    expect(argv("echo \\")).toEqual([["echo", ""]]);
  });
  it("double quotes: escapes, continuations, backticks and substitutions", () => {
    expect(argv('echo "a\\"b\\$c\\\\d\\xe"')).toEqual([["echo", 'a"b$c\\d\\xe']]);
    expect(argv('echo "a\\\nb"')).toEqual([["echo", "ab"]]);
    expect(argv('echo "x`id`y"')).toEqual([["echo", `x${SUBSTITUTION_PLACEHOLDER}y`], ["id"]]);
    expect(argv('echo $"loc"')).toEqual([["echo", "loc"]]);
  });
  it("a lone or trailing `$` is literal", () => {
    expect(parseShellWords("echo $ a$ $%")).toEqual([
      [
        { text: "echo", unresolved: false },
        { text: "$", unresolved: false },
        { text: "a$", unresolved: false },
        { text: "$%", unresolved: false },
      ],
    ]);
  });
  it("special parameters and numeric arithmetic are dynamic", () => {
    const [cmd] = parseShellWords("echo $1 $@ ${#} $((1+2))");
    expect(cmd?.slice(1).map((w) => w.unresolved)).toEqual([true, true, true, true]);
  });
  it("`;;`, `;&` and `|&` separate commands", () => {
    expect(argv("a;; b;& c |& d")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });
  it("comments run to the end of the line; `#` inside a word is literal", () => {
    expect(argv("echo a#b # rm -rf /\nls")).toEqual([["echo", "a#b"], ["ls"]]);
  });
  it("fd duplication is not recorded; `>&file` writes the file", () => {
    expect(parseScript("ls 2>&1 >&- <&0").commands[0]?.redirects).toEqual([]);
    expect(parseScript("ls >&out").commands[0]?.redirects).toEqual([
      { op: "&>", target: { text: "out", unresolved: false } },
    ]);
    expect(parseScript("cat <> f").commands[0]?.redirects[0]?.op).toBe("<>");
    expect(parseScript("echo x &>>! f").commands[0]?.redirects[0]?.op).toBe("&>>");
  });
  it("scans quotes, escapes and nested parens inside $( )", () => {
    expect(argv(`echo $(printf ')' "\\")" \\) (x))`)).toEqual([
      ["echo", SUBSTITUTION_PLACEHOLDER],
      ["printf", ")", '")', ")"],
      ["x"],
    ]);
  });
  it("backticks unescape \\$, \\` and \\\\ only", () => {
    expect(argv("echo `printf \\$x\\n\\\\`")).toEqual([
      ["echo", SUBSTITUTION_PLACEHOLDER],
      ["printf", "$xn"],
    ]);
  });
});

describe("here-documents", () => {
  it("an unquoted body runs its substitutions and backticks, skipping escaped ones", () => {
    const cmds = argv("cat <<EOF\n\\$(no) $(yes) `also` $X\nEOF\nls");
    expect(cmds).toEqual([["cat"], ["yes"], ["also"], ["echo", "$X"], ["ls"]]);
  });
  it("a quoted body is data; <<- strips leading tabs from the delimiter line", () => {
    expect(argv("cat <<'EOF'\n$(rm -rf /)\nEOF")).toEqual([["cat"]]);
    expect(argv("cat <<-EOF\n\tx\n\tEOF\nls")).toEqual([["cat"], ["ls"]]);
  });
});

describe("$'...' decoding", () => {
  it.each([
    ["\\x41\\x4a", "AJ"],
    ["\\u00e9\\U0001F600", "é😀"],
    ["\\xZZ", "\\xZZ"],
    ["\\uZ", "\\uZ"],
    ["\\101\\7", "A\x07"],
    ["\\cA\\c", "\x01\\c"],
    ["\\cA", "\x01"],
    ["\\q", "\\q"],
    ["\\n\\'", "\n'"],
  ])("$'%s'", (body, text) => {
    expect(argv(`echo $'${body}'`)).toEqual([["echo", text]]);
  });
});

describe("$'\\c' before the closing quote", () => {
  it("does not swallow the quote, so the commands after it are seen", () => {
    // bash and zsh run `rm -rf /` here; swallowing the quote would hide it inside one long word.
    const src = `echo $'\\c'; rm -rf /; echo "'" # "`;
    expect(parseScript(src)).toEqual({
      commands: [
        {
          words: [
            { text: "echo", unresolved: false },
            { text: "\\c", unresolved: false },
          ],
          redirects: [],
        },
        {
          words: [
            { text: "rm", unresolved: false },
            { text: "-rf", unresolved: false },
            { text: "/", unresolved: false },
          ],
          redirects: [],
        },
        {
          words: [
            { text: "echo", unresolved: false },
            { text: "'", unresolved: false },
          ],
          redirects: [],
        },
      ],
    });
  });
});
