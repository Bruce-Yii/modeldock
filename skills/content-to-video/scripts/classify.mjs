#!/usr/bin/env node
// classify.mjs - Turn source content into a video production recommendation.
//
// Usage:
//   node classify.mjs <path-to-content-file>
//   node classify.mjs "inline text"
//   Get-Content file.txt -Raw | node classify.mjs --stdin
//
// Output: JSON with a primary content-type classification (with confidence
// and reasons) and a production recommendation (pipeline, format, duration,
// pacing, visual strategy, TTS profile, language). This is a decision aid:
// the agent still validates against references/classification.md and may
// override when user intent or context says otherwise.

import { readFileSync, existsSync } from "node:fs";

const STDIN = process.argv.includes("--stdin");
const arg = process.argv
  .slice(2)
  .filter((a) => a !== "--stdin")
  .join(" ")
  .trim();

let input = arg;
if (!STDIN && arg && existsSync(arg)) {
  input = readFileSync(arg, "utf8");
} else if (STDIN) {
  input = readFileSync(0, "utf8");
}
if (!input) {
  console.error("usage: node classify.mjs <file|text>   |   echo text | node classify.mjs --stdin");
  process.exit(2);
}

const raw = input.slice(0, 40000);
const text = raw.toLowerCase();
const wordCount = text.split(/\s+/).filter(Boolean).length;
const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(raw);
const langHint = hasCJK ? "zh-CN" : "en-US";

// ---------------------------------------------------------------------------
// Signal scoring. Each detector returns a weight (specificity) and evidence.
// ---------------------------------------------------------------------------
const SIGNALS = [
  {
    type: "promo",
    weight: 1.0,
    test: (t) =>
      /(install|download|pricing|launch|sign ?up|start ?free|for developers|for teams|product tour|feature highlights?|what'?s new|v?\d+\.\d+(\.\d+)? release|changelog|beta|early access)/.test(t),
  },
  {
    type: "promo",
    weight: 0.6,
    test: (t) => /(sponsored|advertis|limited time|try it now|get started today|built for|empowers?|supercharge)/.test(t),
  },
  {
    type: "tutorial",
    weight: 1.0,
    test: (t) =>
      /(how to |how-?to|step ?[0-9]|step by step|setup|set up|configuration|configure|usage guide|quickstart|quick start|command line|terminal|npm install|pip install|run the following)/.test(t),
  },
  {
    type: "tutorial",
    weight: 0.6,
    test: (t) => /(example|examples?|output|error|troubleshoot|faq|first create|then|finally)/.test(t) && /(```|install|run)/.test(t),
  },
  {
    type: "story",
    weight: 1.0,
    test: (t) =>
      /(once upon a time|chapter [0-9]|act (i|ii|iii|one|two|three)|novel|short story|screenplay|dialogue|said |whispered|villain|heroine|protagonist|climax|plot twist)/.test(t),
  },
  {
    type: "story",
    weight: 0.5,
    test: (t) => /(she (walked|looked|felt)|he (walked|looked|felt)|the door opened|it was a (cold|dark|sunny|quiet))/.test(t),
  },
  {
    type: "slides",
    weight: 1.0,
    test: (t) => /(slide|agenda|table of contents|key takeaways|deck|powerpoint|pptx|keynote)/.test(t),
  },
  {
    type: "data",
    weight: 1.0,
    test: (t) =>
      /(\d+(\.\d+)?%|\$\s?\d+(\.\d+)?[kmbt]?|\d+\.\d+ (million|billion)|revenue|downloads|statistics?|quarterly|year-over-year|growth rate|market (size|share)|chart below)/.test(t),
  },
  {
    type: "data",
    weight: 0.5,
    test: (t) => /(report|survey|benchmark|metric|kpi|dataset|dashboard)/.test(t),
  },
  {
    type: "social",
    weight: 1.0,
    test: (t) => /(top ?(5|10|3)|life ?hacks?|tips? that|viral|trending|tiktok|reels?|shorts|challenge|#\w+)/.test(t),
  },
  {
    type: "social",
    weight: 0.4,
    test: (t) => /(so easy|watch till the end|you won'?t believe|number [0-9])/.test(t),
  },
  {
    type: "podcast",
    weight: 1.0,
    test: (t) => /(episode [0-9]+|transcript|podcast|host:|guest:|intro music|conversation with)/.test(t),
  },
  {
    type: "explainer",
    weight: 0.9,
    test: (t) => /(what is |how does it work|how it works|explain|explainer|overview|in this (article|post|guide)|deep dive|understand|concept)/.test(t),
  },
  {
    type: "explainer",
    weight: 0.4,
    test: (t) => /(in other words|for example|think of it as|at its core)/.test(t),
  },
];

const audioExt = /\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i.test(arg);
const slideExt = /\.(pptx?|key|pdf)$/i.test(arg);
const docExt = /\.(md|txt|docx?|html?|rst)$/i.test(arg);

function classify() {
  const scores = {};
  const evidence = {};
  for (const s of SIGNALS) {
    if (s.test(text)) {
      scores[s.type] = (scores[s.type] || 0) + s.weight;
      (evidence[s.type] = evidence[s.type] || []).push(s.weight >= 1 ? "strong" : "weak");
    }
  }
  // File-extension overrides.
  if (audioExt) scores.podcast = Math.max(scores.podcast || 0, 4);
  if (slideExt) scores.slides = Math.max(scores.slides || 0, 4);
  // Very short text with marketing signals is usually social-first.
  if (wordCount < 80 && (scores.social || scores.promo) && !scores.explainer) {
    if (!scores.social) scores.social = (scores.promo || 0) * 0.5;
  }
  // Long prose with no strong signals defaults to explainer.
  if (wordCount > 400 && !Object.keys(scores).length) scores.explainer = 0.8;

  const ranked = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([type, score]) => ({ type, score: Math.round(score * 100) / 100 }));

  const top = ranked[0];
  if (!top) return { primary: null, candidates: [], recommendation: fallback() };

  const total = ranked.reduce((a, b) => a + b.score, 0) || 1;
  const confidence = Math.min(0.98, 0.35 + top.score / total);
  return {
    primary: {
      content_type: top.type,
      confidence: Math.round(confidence * 100) / 100,
      evidence: evidence[top.type] || [],
    },
    candidates: ranked.slice(0, 3),
    recommendation: recommend(top.type),
  };
}

function recommend(type) {
  const map = {
    promo: {
      pipeline: "promo",
      format: "16:9",
      duration_target_s: 45,
      pacing: "standard",
      render_backend: "bundled",
      visual_strategy: "real-UI hero + 3D core + labeled identity, atmosphere via image-gen",
      tts_profile: "authoritative mature voice (e.g. zh-CN-YunyangNeural / en-US-ChristopherNeural), rate -8%",
    },
    explainer: {
      pipeline: "explainer",
      format: "16:9",
      duration_target_s: 75,
      pacing: "standard",
      render_backend: "bundled",
      visual_strategy: "diagrams + real UI + numbered concept cards, Ken Burns stills for metaphors",
      tts_profile: "clear neutral voice (e.g. zh-CN-XiaoxiaoNeural / en-US-AriaNeural), rate -5%",
    },
    tutorial: {
      pipeline: "tutorial",
      format: "16:9",
      duration_target_s: 120,
      pacing: "standard",
      render_backend: "bundled",
      visual_strategy: "screen capture first-class; step supers, chapter markers, cursor highlights",
      tts_profile: "friendly instructional voice (e.g. zh-CN-XiaoxiaoNeural / en-US-GuyNeural), rate -5%",
    },
    story: {
      pipeline: "story",
      format: "16:9",
      duration_target_s: 120,
      pacing: "slow",
      render_backend: "bundled",
      visual_strategy: "three.js cinematic scenes, style anchors, voice acting, end-card moral",
      tts_profile: "storytelling voice (e.g. zh-CN-YunxiNeural / en-US-ChristopherNeural), rate -10%",
    },
    slides: {
      pipeline: "slides-to-video",
      format: "16:9",
      duration_target_s: 90,
      pacing: "standard",
      render_backend: "bundled",
      visual_strategy: "render each slide as a scene; Ken Burns + speaker narration + section transitions",
      tts_profile: "presenter voice (e.g. zh-CN-YunyangNeural / en-US-AndrewNeural), rate -5%",
    },
    data: {
      pipeline: "data-story",
      format: "16:9",
      duration_target_s: 60,
      pacing: "standard",
      render_backend: "hyperframes",
      visual_strategy: "canvas/SVG charts with annotation callouts + narration; animated axes and counters",
      tts_profile: "authoritative voice, rate -5%",
    },
    social: {
      pipeline: "social-vertical",
      format: "9:16",
      duration_target_s: 30,
      pacing: "fast",
      render_backend: "hyperframes",
      visual_strategy: "big burned captions, fast cuts, countdown/CTA hooks, vertical-safe margins",
      tts_profile: "energetic voice, rate 0%",
    },
    podcast: {
      pipeline: "podcast-video",
      format: "16:9",
      duration_target_s: 180,
      pacing: "slow",
      render_backend: "bundled",
      visual_strategy: "waveform + transcript cards + b-roll; face or avatar optional",
      tts_profile: "natural conversational voice, rate 0%",
    },
  };
  return map[type] || fallback();
}

function fallback() {
  return {
    pipeline: "explainer",
    format: "16:9",
    duration_target_s: 60,
    pacing: "standard",
    render_backend: "bundled",
    visual_strategy: "unified scene pipeline: narration-driven, real-UI proof, Ken Burns stills",
    tts_profile: "clear neutral voice, rate -5%",
  };
}

const result = classify();
result.input = {
  chars: raw.length,
  words: wordCount,
  lang_hint: langHint,
  file_ext_hint: audioExt ? "audio" : slideExt ? "slides" : docExt ? "document" : "text",
};
console.log(JSON.stringify(result, null, 2));
