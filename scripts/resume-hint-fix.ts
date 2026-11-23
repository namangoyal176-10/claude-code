/**
 * Fix for GitHub Issue #109558:
 * [BUG] CLAUDE_CODE_RESUME_HINT_COMMAND is ignored if it contains whitespace.
 *
 * In Claude Code, CLAUDE_CODE_RESUME_HINT_COMMAND was previously validated
 * using `/^\w[\w-]*$/`, which rejected any command containing spaces or arguments
 * (such as "foo bar" or "my-tool run claude") and silently fell back to "claude --resume".
 *
 * This module provides the safe command validator and resume hint generator
 * supporting whitespace, multi-word commands, paths, and quoted arguments, while
 * strictly preventing command injection.
 */

/**
 * Validates that a custom launcher command string is safe for display and execution in the resume hint.
 *
 * Allows:
 * - Single-word commands: "foo", "my-claude"
 * - Multi-word commands and subcommands: "foo bar", "my-tool run claude"
 * - Multi-argument flags: "my-tool --profile dev --config /path"
 * - Balanced quoted arguments: "tool 'quoted argument'", 'tool "nested arg"'
 * - Absolute or relative paths: "/usr/local/bin/foo", "./bin/claude"
 *
 * Rejects (Security Protections):
 * - Dangerous shell execution/chaining characters: ;, &, |, `, $, >, <
 * - Control characters, newlines, null bytes (\r, \n, \0)
 * - Unbalanced quotes
 * - Empty or whitespace-only inputs
 * - Leading flag/option arguments (-flag, =arg)
 */
export function isValidLauncherCommand(cmd: unknown): cmd is string {
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Reject newlines, null bytes, and ASCII control characters
  if (/[\r\n\0\x01-\x1f\x7f]/.test(trimmed)) {
    return false;
  }

  // Reject shell statement separators, piping, redirection, and subshell expansion
  if (/[\x00\r\n;&|`$><]/.test(trimmed)) {
    return false;
  }

  // Ensure single and double quotes are properly paired and balanced
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  if (inSingle || inDouble) {
    return false;
  }

  // Command must start with an executable name or path, not a flag or assignment
  if (/^[-=]/.test(trimmed)) {
    return false;
  }

  return true;
}

export interface ResumeHintOptions {
  sessionId?: string;
  launcherProgram?: string;
  worktree?: { name: string; recordCleared: boolean };
  envAssignment?: string;
  launchFlags?: string;
}

export interface ResumeHintResult {
  advice: string[];
  command: string;
  arg: "id" | "none";
  flags: boolean;
  launcher: boolean;
  worktree: "absent" | "refused" | "printed";
}

/**
 * Generates the resume hint matching Claude Code's session exit logic.
 */
export function formatResumeHint({
  sessionId,
  launcherProgram,
  worktree,
  envAssignment,
  launchFlags = "",
}: ResumeHintOptions): ResumeHintResult {
  const defaultCommand = envAssignment === undefined ? "claude" : `${envAssignment} claude`;
  const sessionArg = sessionId ? ` ${sessionId}` : "";
  const argType = sessionId ? "id" : "none";

  // Preserve custom launcher command with whitespace support
  if (launcherProgram !== undefined && isValidLauncherCommand(launcherProgram)) {
    const launcher = launcherProgram.trim();
    return {
      advice: [],
      command: `${launcher} --resume${sessionArg}`,
      arg: argType,
      flags: false,
      launcher: true,
      worktree: worktree === undefined ? "absent" : "refused",
    };
  }

  // Fall back to standard claude resume hint
  const effectiveFlags = launchFlags ? ` ${launchFlags}` : "";
  return {
    advice: [],
    command: `${defaultCommand}${effectiveFlags} --resume${sessionArg}`,
    arg: argType,
    flags: launchFlags !== "",
    launcher: false,
    worktree: worktree === undefined ? "absent" : "printed",
  };
}

// Regression test suite
export function runTests(): boolean {
  const testCases = [
    { name: "Single-word command", env: "foo", expected: "foo --resume test-session", launcher: true },
    { name: "Command with whitespace", env: "foo bar", expected: "foo bar --resume test-session", launcher: true },
    { name: "Command with multiple arguments", env: "my-tool run --profile dev", expected: "my-tool run --profile dev --resume test-session", launcher: true },
    { name: "Environment variable not set", env: undefined, expected: "claude --resume test-session", launcher: false },
    { name: "Empty environment variable", env: "", expected: "claude --resume test-session", launcher: false },
    { name: "Whitespace-only environment variable", env: "   ", expected: "claude --resume test-session", launcher: false },
    { name: "Command containing path", env: "/usr/local/bin/foo", expected: "/usr/local/bin/foo --resume test-session", launcher: true },
    { name: "Command with quoted arguments", env: 'my-cli "profile name"', expected: 'my-cli "profile name" --resume test-session', launcher: true },
    { name: "Security: command with semicolon rejected", env: "foo; rm -rf /", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with && rejected", env: "foo && bar", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with pipe rejected", env: "foo | bash", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with $(id) rejected", env: "foo $(id)", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with backticks rejected", env: "foo `id`", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with newline rejected", env: "foo\nbar", expected: "claude --resume test-session", launcher: false },
    { name: "Security: command with unbalanced quotes rejected", env: 'foo "bar', expected: "claude --resume test-session", launcher: false },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const result = formatResumeHint({ sessionId: "test-session", launcherProgram: tc.env });
    if (result.command === tc.expected && result.launcher === tc.launcher) {
      passed++;
    } else {
      console.error(`FAIL: ${tc.name} -> got "${result.command}" (launcher: ${result.launcher}), expected "${tc.expected}"`);
    }
  }

  console.log(`Ran ${testCases.length} tests: ${passed} passed, ${testCases.length - passed} failed.`);
  return passed === testCases.length;
}

if (import.meta.main || process.argv[1]?.endsWith("resume-hint-fix.ts")) {
  const success = runTests();
  if (!success) process.exit(1);
}
