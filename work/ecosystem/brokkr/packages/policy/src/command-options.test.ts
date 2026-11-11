import { describe, expect, it } from "vitest";
import { INLINE_CODE, analyzeCommand } from "./index.js";

// Option spellings the tools accept that put code on the command line: GNU getopt_long
// (sed, gawk, make, GNU tar) and bsdtar take any unambiguous prefix of a long option,
// short options take their value attached, and tar reads old-style letters in argv[1].
describe("analyzeCommand: inline code behind option spellings", () => {
  const DENY: Array<[string[], string]> = [
    // sed: `-l N` takes a value, so the script is the token after it
    [["sed", "-l", "5", "1e id", "f"], INLINE_CODE],
    [["sed", "-nl", "5", "1e id", "f"], INLINE_CODE],
    [["sed", "--line-length", "5", "1e id", "f"], INLINE_CODE],
    [["sed", "--line=5", "1e id", "f"], INLINE_CODE],
    // sed: abbreviated --expression
    [["sed", "--expr=1e id", "f"], INLINE_CODE],
    [["sed", "--e=1e id", "f"], INLINE_CODE],
    [["sed", "-f", "x.sed", "--exp", "1e id", "f"], INLINE_CODE],
    // gawk: attached -e, clustered -e, abbreviated --source, next to a program file
    [["gawk", "-f", "p.awk", '-eBEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "p.awk", "-b", "-e", 'BEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "p.awk", '-beBEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "p.awk", '--sour=BEGIN{system("id")}'], INLINE_CODE],
    [["gawk", "-f", "p.awk", "--so", 'BEGIN{system("id")}'], INLINE_CODE],
    // make: -E is --eval (GNU make 4.4), and --eval abbreviated
    [["make", "-E", "$(shell id)"], INLINE_CODE],
    [["make", "-kE$(shell id)"], INLINE_CODE],
    [["gmake", "--ev=$(shell id)"], INLINE_CODE],
    [["make", "--eva", "$(shell id)"], INLINE_CODE],
    // tar: -I / -F inside a short cluster, old-style letters, abbreviated long options
    [["tar", "-xIid", "-fa.tgz"], INLINE_CODE],
    [["tar", "-xvI", "id", "-f", "a.tgz"], INLINE_CODE],
    [["tar", "-xF", "id", "-f", "a.tgz"], INLINE_CODE],
    [["tar", "xIf", "id", "a.tgz"], INLINE_CODE],
    [["gtar", "--to-c=id", "-xf", "a.tgz"], INLINE_CODE],
    [["bsdtar", "--use=id", "-xf", "a.tgz"], INLINE_CODE],
    [["tar", "--checkpoint-act=exec=id", "-xf", "a.tgz"], INLINE_CODE],
    [["tar", "--rsh=id", "-xf", "h:a.tgz"], INLINE_CODE],
    [["tar", "--info=id", "-cf", "a.tar", "d"], INLINE_CODE],
    [["tar", "--new-vol=id", "-cf", "a.tar", "d"], INLINE_CODE],
    // perl: -M/-m text is compiled as `use <text>;`
    [["perl", "-Mstrict;system(q(id))", "a.pl"], INLINE_CODE],
    [["perl", "-wmPOSIX;system(q(id))", "a.pl"], INLINE_CODE],
  ];
  for (const [argv, label] of DENY) {
    it(`denies ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBe(label);
    });
  }

  const ALLOW: string[][] = [
    ["sed", "-l", "80", "-n", "1p", "f"],
    ["sed", "--line-length=80", "s/a/b/", "f"],
    ["sed", "-n", "--expr=1p", "f"],
    ["sed", "--fi=x.sed", "e"],
    ["sed", "-i", "s/a/b/", "e"],
    ["sed", "--", "s/a/b/", "f"],
    ["gawk", "-f", "p.awk", "-v", "e=1", "data"],
    ["gawk", "-f", "p.awk", "-ve=1", "data"],
    ["gawk", "-f", "p.awk", "--sandbox", "data"],
    ["make", "-C", "web", "build"],
    ["make", "-fEvil.mk", "build"],
    ["make", "--environment-overrides", "build"],
    ["tar", "-xzf", "a.tgz"],
    ["tar", "xzf", "a.tgz"],
    ["tar", "-cf", "out.tar", "-C", "dir", "."],
    ["tar", "-xf", "a.tar", "--checkpoint=10"],
    ["tar", "-xf", "a.tar", "--to-stdout"],
    ["perl", "-MList::Util=sum,max", "a.pl"],
    ["perl", "-M-warnings", "a.pl"],
    ["perl", "a.pl", "-Mx;y"],
  ];
  for (const argv of ALLOW) {
    it(`allows ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBeUndefined();
    });
  }
});

describe("analyzeCommand: registry-mutating aliases", () => {
  it("npm dist-tags is dist-tag; yarn tag and yarn npm tag change dist-tags too", () => {
    for (const argv of [
      ["npm", "dist-tags", "add", "a@1", "latest"],
      ["yarn", "tag", "add", "a@1", "latest"],
      ["yarn", "npm", "tag", "add", "a@1", "latest"],
    ])
      expect(analyzeCommand(argv), argv.join(" ")).toMatchObject({
        destructive: "publish",
        needsNetwork: true,
      });
  });

  it("npm udpate is npm's documented alias of update", () => {
    expect(analyzeCommand(["npm", "udpate"])).toMatchObject({
      dependencyInstall: true,
      needsNetwork: true,
    });
  });
});
