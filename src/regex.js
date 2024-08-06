import {Context, hasUnescaped, replaceUnescaped} from 'regex-utilities';
import {CharClassContext, RegexContext, adjustNumberedBackrefs, capturingDelim, containsCharClassUnion, countCaptures, emulationGroupMarker, escapeV, flagVSupported, getBreakoutChar, getEndContextForIncompleteExpression, patternModsSupported, preprocess, sandboxLoneCharClassCaret, sandboxLoneDoublePunctuatorChar, sandboxUnsafeNulls} from './utils.js';
import {Pattern, pattern} from './pattern.js';
import {flagNPreprocessor} from './flag-n.js';
import {flagXPreprocessor, cleanPlugin} from './flag-x.js';
import {atomicPlugin} from './atomic-groups.js';
import {subroutinesPlugin} from './subroutines.js';
import {backcompatPlugin} from './backcompat.js';

/**
@typedef {string | RegExp | Pattern | number} InterpolatedValue
@typedef {{flags: string; useEmulationGroups: boolean;}} PluginData
@typedef {TemplateStringsArray | {raw: Array<string>}} RawTemplate
@typedef {{
  flags?: string;
  subclass?: boolean;
  plugins?: Array<(expression: string, data: PluginData) => string>;
  unicodeSetsPlugin?: ((expression: string, data: PluginData) => string) | null;
  disable?: {
    x?: boolean;
    n?: boolean;
    v?: boolean;
    atomic?: boolean;
    subroutines?: boolean;
  };
  force?: {
    v?: boolean;
  };
}} RegexTagOptions
*/
/**
@template T
@typedef RegexTag
@type {{
  (template: RawTemplate, ...substitutions: ReadonlyArray<InterpolatedValue>): T;
  (flags?: string): RegexTag<T>;
  (options: RegexTagOptions & {subclass?: false}): RegexTag<T>;
  (options: RegexTagOptions & {subclass: true}): RegexTag<WrappedRegex>;
}}
*/
/**
Template tag for constructing a regex with extended syntax and context-aware interpolation of
regexes, strings, and patterns.

Can be called in several ways:
1. `` regex`…` `` - Regex pattern as a raw string.
2. `` regex('gi')`…` `` - To specify flags.
3. `` regex({flags: 'gi'})`…` `` - With options.
@type {RegexTag<RegExp>}
*/
const regex = (first, ...substitutions) => {
  // Given a template
  if (Array.isArray(first?.raw)) {
    return regexFromTemplate({}, first, ...substitutions);
  // Given flags
  } else if ((typeof first === 'string' || first === undefined) && !substitutions.length) {
    return regexFromTemplate.bind(null, {flags: first});
  // Given an options object
  } else if ({}.toString.call(first) === '[object Object]' && !substitutions.length) {
    return regexFromTemplate.bind(null, first);
  }
  throw new Error(`Unexpected arguments: ${JSON.stringify([first, ...substitutions])}`);
}

/**
@template T
@typedef RegexFromTemplate
@type {{
  (options: RegexTagOptions, template: RawTemplate, ...substitutions: ReadonlyArray<InterpolatedValue>) : T;
}}
*/
/**
Returns a RegExp from a template and substitutions to fill the template holes.
@type {RegexFromTemplate<RegExp>}
*/
const regexFromTemplate = (options, template, ...substitutions) => {
  const {
    flags = '',
    subclass = false,
    plugins = [],
    unicodeSetsPlugin = backcompatPlugin,
    disable = {},
    force = {},
  } = options;
  if (/[vu]/.test(flags)) {
    throw new Error('Flags v/u cannot be explicitly added');
  }
  const useFlagV = force.v || (disable.v ? false : flagVSupported);
  const fullFlags = (useFlagV ? 'v' : 'u') + flags;

  // Implicit flag x is handled first because otherwise some regex syntax (if unescaped) within
  // comments could cause problems when parsing
  if (!disable.x) {
    ({template, substitutions} = preprocess(template, substitutions, flagXPreprocessor));
  }
  // Implicit flag n is a preprocessor because capturing groups affect backreference rewriting in
  // both interpolation and plugins
  if (!disable.n) {
    ({template, substitutions} = preprocess(template, substitutions, flagNPreprocessor));
  }

  let precedingCaptures = 0;
  let expression = '';
  let runningContext;
  // Intersperse raw template strings and substitutions
  template.raw.forEach((raw, i) => {
    const wrapEscapedStr = !!(template.raw[i] || template.raw[i + 1]);
    // Even with flag n enabled, we might have named captures
    precedingCaptures += countCaptures(raw);
    // Sandbox `\0` in character classes. Not needed outside character classes because in other
    // cases a following interpolated value would always be atomized
    expression += sandboxUnsafeNulls(raw, Context.CHAR_CLASS);
    runningContext = getEndContextForIncompleteExpression(expression, runningContext);
    const {regexContext, charClassContext} = runningContext;
    if (i < template.raw.length - 1) {
      const substitution = substitutions[i];
      expression += interpolate(substitution, flags, regexContext, charClassContext, wrapEscapedStr, precedingCaptures);
      if (substitution instanceof RegExp) {
        precedingCaptures += countCaptures(substitution.source);
      } else if (substitution instanceof Pattern) {
        precedingCaptures += countCaptures(String(substitution));
      }
    }
  });

  [ ...plugins, // Run first, so provided plugins can output extended syntax
    ...(disable.atomic ? [] : [atomicPlugin]),
    ...(disable.subroutines ? [] : [subroutinesPlugin]),
    ...(disable.x ? [] : [cleanPlugin]),
    // Run last, so it doesn't have to worry about parsing extended syntax
    ...(useFlagV || !unicodeSetsPlugin ? [] : [unicodeSetsPlugin]),
  ].forEach(p => expression = p(expression, {flags: fullFlags, useEmulationGroups: subclass}));
  if (subclass) {
    const unmarked = unmarkEmulationGroups(expression);
    return new WrappedRegex(unmarked.expression, fullFlags, {captureNums: unmarked.captureNums});
  }
  return new RegExp(expression, fullFlags);
}

/**
@typedef {Array<number | null>} EmulationGroupSlots
*/
class WrappedRegex extends RegExp {
  #captureNums;
  /**
  @param {string | WrappedRegex} expression
  @param {string} [flags]
  @param {{captureNums: EmulationGroupSlots;}} [data]
  */
  constructor(expression, flags, data) {
    super(expression, flags);
    if (data) {
      this.#captureNums = data.captureNums;
    // The third argument `data` isn't provided when regexes are copied as part of the internal
    // handling of string methods `matchAll` and `split`
    } else if (expression instanceof WrappedRegex) {
      // Can read private properties of the existing object since it was created by this class
      this.#captureNums = expression.#captureNums;
    }
  }
  /**
  Called internally by all String/RegExp methods that use regexes.
  @override
  @param {string} str
  @returns {RegExpExecArray | null}
  */
  exec(str) {
    const match = RegExp.prototype.exec.call(this, str);
    if (!match || !this.#captureNums) {
      return match;
    }
    const copy = [...match];
    // Empty all but the first value of the array while preserving its other properties
    match.length = 1;
    for (let i = 1; i < copy.length; i++) {
      if (this.#captureNums[i] !== null) {
        match.push(copy[i]);
      }
    }
    return match;
  }
}

/**
@param {InterpolatedValue} value
@param {string} flags
@param {string} regexContext
@param {string} charClassContext
@param {boolean} wrapEscapedStr
@param {number} precedingCaptures
@returns {string}
*/
function interpolate(value, flags, regexContext, charClassContext, wrapEscapedStr, precedingCaptures) {
  if (value instanceof RegExp && regexContext !== RegexContext.DEFAULT) {
    throw new Error('Cannot interpolate a RegExp at this position because the syntax context does not match');
  }
  if (regexContext === RegexContext.INVALID_INCOMPLETE_TOKEN || charClassContext === CharClassContext.INVALID_INCOMPLETE_TOKEN) {
    // Throw in all cases, but only *need* to handle a preceding unescaped backslash (which would
    // break sandboxing) since other errors would be handled by the invalid generated regex syntax
    throw new Error('Interpolation preceded by invalid incomplete token');
  }
  const isPattern = value instanceof Pattern;
  let escapedValue = '';
  if (!(value instanceof RegExp)) {
    value = String(value);
    if (!isPattern) {
      escapedValue = escapeV(
        value,
        regexContext === RegexContext.CHAR_CLASS ? Context.CHAR_CLASS : Context.DEFAULT
      );
    }
    // Check `escapedValue` (not just patterns) since possible breakout char `>` isn't escaped
    const breakoutChar = getBreakoutChar(escapedValue || value, regexContext, charClassContext);
    if (breakoutChar) {
      throw new Error(`Unescaped stray "${breakoutChar}" in the interpolated value would have side effects outside it`);
    }
  }

  if (
    regexContext === RegexContext.ENCLOSED_TOKEN ||
    regexContext === RegexContext.INTERVAL_QUANTIFIER ||
    regexContext === RegexContext.GROUP_NAME ||
    charClassContext === CharClassContext.ENCLOSED_TOKEN ||
    charClassContext === CharClassContext.Q_TOKEN
  ) {
    return isPattern ? String(value) : escapedValue;
  } else if (regexContext === RegexContext.CHAR_CLASS) {
    if (isPattern) {
      if (hasUnescaped(String(value), '^-|^&&|-$|&&$')) {
        // Sandboxing so we don't change the chars outside the pattern into being part of an
        // operation they didn't initiate. Same problem as starting a pattern with a quantifier
        throw new Error('Cannot use range or set operator at boundary of interpolated pattern; move the operation into the pattern or the operator outside of it');
      }
      const sandboxedValue = sandboxLoneCharClassCaret(sandboxLoneDoublePunctuatorChar(value));
      // Atomize via nested character class `[…]` if it contains implicit or explicit union (check
      // the unadjusted value)
      return containsCharClassUnion(value) ? `[${sandboxedValue}]` : sandboxUnsafeNulls(sandboxedValue);
    }
    // Atomize via nested character class `[…]` if more than one node
    return containsCharClassUnion(escapedValue) ? `[${escapedValue}]` : escapedValue;
  }
  // `RegexContext.DEFAULT`
  if (value instanceof RegExp) {
    const transformed = transformForLocalFlags(value, flags);
    const backrefsAdjusted = adjustNumberedBackrefs(transformed.value, precedingCaptures);
    // Sandbox and atomize; if we used a pattern modifier it has the same effect
    return transformed.usedModifier ? backrefsAdjusted : `(?:${backrefsAdjusted})`;
  }
  if (isPattern) {
    // Sandbox and atomize
    return `(?:${value})`;
  }
  // Sandbox and atomize
  return wrapEscapedStr ? `(?:${escapedValue})` : escapedValue;
}

/**
@param {RegExp} re
@param {string} outerFlags
@returns {{value: string; usedModifier?: boolean;}}
*/
function transformForLocalFlags(re, outerFlags) {
  /** @type {{i: boolean | null; m: boolean | null; s: boolean | null;}} */
  const modFlagsObj = {
    i: null,
    m: null,
    s: null,
  };
  const newlines = '\\n\\r\\u2028\\u2029';
  let value = re.source;
  if (re.ignoreCase !== outerFlags.includes('i')) {
    if (patternModsSupported) {
      modFlagsObj.i = re.ignoreCase;
    } else {
      throw new Error('Pattern modifiers not supported, so the value of flag i on the interpolated RegExp must match the outer regex');
    }
  }
  if (re.dotAll !== outerFlags.includes('s')) {
    if (patternModsSupported) {
      modFlagsObj.s = re.dotAll;
    } else {
      value = replaceUnescaped(value, '\\.', (re.dotAll ? '[^]' : `[^${newlines}]`), Context.DEFAULT);
    }
  }
  if (re.multiline !== outerFlags.includes('m')) {
    if (patternModsSupported) {
      modFlagsObj.m = re.multiline;
    } else {
      value = replaceUnescaped(value, '\\^', (re.multiline ? `(?<=^|[${newlines}])` : '(?<![^])'), Context.DEFAULT);
      value = replaceUnescaped(value, '\\$', (re.multiline ? `(?=$|[${newlines}])` : '(?![^])'), Context.DEFAULT);
    }
  }
  if (patternModsSupported) {
    const keys = Object.keys(modFlagsObj);
    let modifier = keys.filter(k => modFlagsObj[k] === true).join('');
    const modOff = keys.filter(k => modFlagsObj[k] === false).join('');
    if (modOff) {
      modifier += `-${modOff}`;
    }
    if (modifier) {
      return {
        value: `(?${modifier}:${value})`,
        usedModifier: true,
      };
    }
  }
  return {value};
}

/**
Build the capture map and remove markers for anonymous captures (added to emulate extended syntax)
@param {string} expression
@returns {{expression: string; captureNums: EmulationGroupSlots;}}
*/
function unmarkEmulationGroups(expression) {
  const marker = emulationGroupMarker.replace(/\$/g, '\\$');
  /** @type {EmulationGroupSlots} */
  const captureNums = [0];
  let captureNum = 0;
  expression = replaceUnescaped(expression, `(?:${capturingDelim})${marker}`, ({0: m}) => {
    captureNum++;
    if (m.endsWith(emulationGroupMarker)) {
      captureNums.push(null);
      return m.slice(0, -emulationGroupMarker.length);
    }
    captureNums.push(captureNum);
    return m;
  }, Context.DEFAULT);
  return {
    captureNums,
    expression,
  };
}

export {regex, pattern};
