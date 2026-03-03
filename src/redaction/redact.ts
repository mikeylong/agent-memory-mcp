const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "openai_key", regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "google_api_key", regex: /AIza[0-9A-Za-z\-_]{35}/g },
  {
    name: "private_key_block",
    regex:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_THRESHOLD = 3.8;

export interface RedactionResult {
  text: string;
  redacted: boolean;
  findings: string[];
}

function shannonEntropy(input: string): number {
  const freq = new Map<string, number>();
  for (const char of input) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

function redactHighEntropyTokens(text: string): { text: string; findings: string[] } {
  const tokens = text.match(/[A-Za-z0-9_\-./+=]{24,}/g) ?? [];
  const findings: string[] = [];
  let redactedText = text;

  for (const token of tokens) {
    if (token.length < ENTROPY_MIN_LENGTH) {
      continue;
    }

    const entropy = shannonEntropy(token);
    const hasMixedCharset = /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token);
    if (entropy >= ENTROPY_THRESHOLD && hasMixedCharset) {
      findings.push("high_entropy_token");
      redactedText = redactedText.split(token).join("[REDACTED_SECRET]");
    }
  }

  return { text: redactedText, findings };
}

export function redactSensitiveText(input: string): RedactionResult {
  let text = input;
  const findings = new Set<string>();

  for (const { name, regex } of PATTERNS) {
    if (regex.test(text)) {
      findings.add(name);
      text = text.replace(regex, `[REDACTED_${name.toUpperCase()}]`);
    }
  }

  text = text.replace(/(Bearer\s+)[A-Za-z0-9._\-]{20,}/gi, (_, prefix: string) => {
    findings.add("bearer_token");
    return `${prefix}[REDACTED_BEARER_TOKEN]`;
  });

  const entropyResult = redactHighEntropyTokens(text);
  text = entropyResult.text;
  for (const finding of entropyResult.findings) {
    findings.add(finding);
  }

  return {
    text,
    redacted: findings.size > 0,
    findings: [...findings],
  };
}
