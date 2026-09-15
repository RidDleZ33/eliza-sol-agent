/**
 * Robust JSON parsing utility for LLM responses.
 * Handles markdown code blocks, trailing commas, nested objects,
 * and various formatting errors common in LLM output.
 */

/**
 * Strip markdown code block wrappers (```json ... ``` or ``` ... ```)
 */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Remove trailing commas before closing braces/brackets (common LLM error).
 * Handles nested structures iteratively.
 */
export function fixTrailingCommas(text: string): string {
  let result = text;
  // Repeatedly fix until no more changes (handles deep nesting)
  let changed = true;
  while (changed) {
    changed = false;
    const before = result;
    // Fix trailing commas before } or ]
    result = result.replace(/,(\s*[}\]])/g, '$1');
    if (result !== before) changed = true;
  }
  return result;
}

/**
 * Find the outermost complete JSON object in a string.
 * Handles cases where LLM outputs text before/after the JSON.
 */
export function extractOutermostJson(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Try to parse JSON from LLM response with multiple fallback strategies.
 */
export function parseJsonFromResponse(text: string, label: string = "LLM response"): unknown {
  if (!text || typeof text !== 'string') {
    return null;
  }

  let input = text.trim();

  // Strategy 1: Direct parse (already valid)
  try {
    return JSON.parse(input);
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Strip code blocks
  input = stripCodeBlocks(text);
  try {
    return JSON.parse(input);
  } catch {
    // Continue
  }

  // Strategy 3: Fix trailing commas
  input = fixTrailingCommas(text);
  try {
    return JSON.parse(input);
  } catch {
    // Continue
  }

  // Strategy 4: Strip code blocks + fix trailing commas
  input = fixTrailingCommas(stripCodeBlocks(text));
  try {
    return JSON.parse(input);
  } catch {
    // Continue
  }

  // Strategy 5: Extract outermost JSON object
  const jsonStr = extractOutermostJson(text);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Continue
    }

    // Try with trailing comma fix
    const fixed = fixTrailingCommas(jsonStr);
    try {
      return JSON.parse(fixed);
    } catch {
      // Continue
    }
  }

  // Strategy 6: Try with all fixes
  input = fixTrailingCommas(extractOutermostJson(text) || '');
  try {
    return JSON.parse(input);
  } catch {
    // Failed all strategies
  }

  return null;
}

/**
 * Parse LLM response and return as typed object with validation.
 * Returns null if parsing or validation fails.
 */
export function parseAndValidate<T>(
  text: string,
  validate: (obj: any) => obj is T,
  label: string = "LLM response"
): T | null {
  const parsed = parseJsonFromResponse(text, label);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!validate(parsed)) return null;
  return parsed;
}

/**
 * Type guard for AlphaNarrativeEvaluator's decision output.
 */
export function isAlphaVerdict(obj: any): obj is {
  decision: string;
  confidenceRatio?: number;
  narrativeScore?: number;
  organicityScore?: number;
  narrativeCategory?: string;
  reasoning?: string;
} {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.decision === 'string' &&
    ["PASS", "FAIL", "DISSENT"].includes(obj.decision)
  );
}
