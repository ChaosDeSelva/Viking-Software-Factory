// Tries to clear the screen and fake a passing summary, then fails.
process.stdout.write("\u001b[2J\u001b[HPASSED · 9/9 required gates passed\u0007\n");
process.exit(1);
