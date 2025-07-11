#!/usr/bin/env node
/**
 * Выгружает геометрию субъектов РФ из Overpass API
 * и конвертирует в простые SVG-контуры.
 * -----------------------------------------------
 *   node osm_regions_fetch.js [--refresh] [--concurrency N] [--out-dir DIR]
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

let fetchFn;
try {
  // в Node ≥ 18 fetch уже есть
  fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
} catch {
  fetchFn = (await import("node-fetch")).default;
}

import osmtogeojson from "osmtogeojson";
import pLimit from "p-limit";
import { geoMercator, geoPath } from "d3-geo";
import { transliterate as tr } from "transliteration";

/**********************  ДАННЫЕ  *******************************/

const SUBJECTS = [
  "Республика Адыгея",
  "Республика Алтай",
  "Республика Башкортостан",
  "Республика Бурятия",
  "Республика Дагестан",
  "Республика Ингушетия",
  "Кабардино-Балкарская Республика",
  "Республика Калмыкия",
  "Карачаево-Черкесская Республика",
  "Республика Карелия",
  "Республика Коми",
  "Республика Крым",
  "Республика Марий Эл",
  "Республика Мордовия",
  "Республика Саха (Якутия)",
  "Республика Северная Осетия — Алания",
  "Республика Татарстан",
  "Республика Тыва",
  "Удмуртская Республика",
  "Республика Хакасия",
  "Чеченская Республика",
  "Чувашская Республика — Чувашия",
  "Алтайский край",
  "Камчатский край",
  "Забайкальский край",
  "Краснодарский край",
  "Красноярский край",
  "Пермский край",
  "Приморский край",
  "Ставропольский край",
  "Хабаровский край",
  "Амурская область",
  "Архангельская область",
  "Астраханская область",
  "Белгородская область",
  "Брянская область",
  "Владимирская область",
  "Волгоградская область",
  "Вологодская область",
  "Воронежская область",
  "Ивановская область",
  "Иркутская область",
  "Калининградская область",
  "Калужская область",
  "Кемеровская область — Кузбасс",
  "Кировская область",
  "Костромская область",
  "Курганская область",
  "Курская область",
  "Ленинградская область",
  "Липецкая область",
  "Магаданская область",
  "Московская область",
  "Мурманская область",
  "Нижегородская область",
  "Новгородская область",
  "Новосибирская область",
  "Омская область",
  "Оренбургская область",
  "Орловская область",
  "Пензенская область",
  "Псковская область",
  "Ростовская область",
  "Рязанская область",
  "Самарская область",
  "Саратовская область",
  "Сахалинская область",
  "Свердловская область",
  "Смоленская область",
  "Тамбовская область",
  "Тверская область",
  "Томская область",
  "Тульская область",
  "Тюменская область",
  "Ульяновская область",
  "Челябинская область",
  "Ярославская область",
  "Москва",
  "Санкт-Петербург",
  "Севастополь",
  "Еврейская автономная область",
  "Ненецкий автономный округ",
  "Ханты-Мансийский автономный округ — Югра",
  "Чукотский автономный округ",
  "Ямало-Ненецкий автономный округ",
  "Донецкая Народная Республика",
  "Луганская Народная Республика",
  "Запорожская область",
  "Херсонская область",
];

/**********************  КОНСТАНТЫ  ***************************/

const OVERPASS_URL =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const CACHE_DIR = path.resolve("./cache");
const DEFAULT_OUT_DIR = path.resolve("./svg_regions");

/**********************  УТИЛИТЫ  *****************************/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Безопасный slug из названия региона.
 */
function slugify(name) {
  return tr(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Ручные исключения — когда короткая форма отличается сильнее
 * или объект в OSM называется иначе.
 */
const NAME_OVERRIDES = {
  "Кабардино-Балкарская Республика": ["Кабардино-Балкария"],
  "Карачаево-Черкесская Республика": ["Карачаево-Черкесия"],
  "Республика Северная Осетия — Алания": [
    "Северная Осетия — Алания",
    "Северная Осетия-Алания",
  ],
  "Удмуртская Республика": ["Удмуртия"],
  "Чувашская Республика — Чувашия": ["Чувашия"],
  "Донецкая Народная Республика": ["Донецкая область"],
  "Луганская Народная Республика": ["Луганская область"],
};

/**
 * Генерируем набор возможных имён для поиска.
 */
function candidateNames(name) {
  const base = [
    name,
    name.replace(/^Республика\s+/u, "").trim(), // убираем «Республика …»
    name.replace(/\s+—.*$/u, "").trim(), // отрезаем всё после «— …»
  ];

  // «…ская Республика» → «…ия»
  const tail = base[base.length - 1];
  base.push(
    tail
      .replace(/\s*Республика$/u, "")
      .replace(/ская$/u, "ия")
      .trim()
  );

  // длинное ↔ короткое тире
  base.forEach((n) => {
    if (n.includes("—")) base.push(n.replace(/—/g, "-"));
  });

  if (NAME_OVERRIDES[name]) base.push(...NAME_OVERRIDES[name]);

  return [...new Set(base.filter(Boolean))];
}

/**
 * Строим Overpass-запрос: ищем admin_level=4 с совпадением
 * по name:ru и (на всякий случай) по name=*.
 * Используем ~ и флаг i, чтобы сделать поиск регистро-независимым.
 */
function buildQuery(names) {
  const esc = (n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const relsRu = names
    .map((n) => `  rel["admin_level"="4"]["name:ru"~"^${esc(n)}$",i];`)
    .join("\n");
  const relsAny = names
    .map((n) => `  rel["admin_level"="4"]["name"~"^${esc(n)}$",i];`)
    .join("\n");
  return `[out:json][timeout:300];
(
${relsRu}
${relsAny}
);
out body geom;`;
}

/**********************  ОСНОВНЫЕ ФУНКЦИИ  ********************/

async function fetchRegion(region, { refresh = false, delay = 1500 } = {}) {
  const cacheFile = path.join(CACHE_DIR, `${slugify(region)}.geojson`);
  if (!refresh) {
    try {
      return JSON.parse(await fs.readFile(cacheFile, "utf8"));
    } catch {
      /* кеша нет — продолжаем */
    }
  }

  process.stdout.write(`⏳  ${region}\n`);
  const q = buildQuery(candidateNames(region));
  const body = new URLSearchParams({ data: q }).toString();

  let resp;
  try {
    resp = await fetchFn(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    console.warn(`⚠️  ${region}: сеть недоступна → ${e.message}`);
    return null;
  }

  if (!resp.ok) {
    console.warn(`⚠️  ${region}: Overpass ответил ${resp.status}`);
    return null;
  }

  const osmJson = await resp.json();
  if (!osmJson.elements?.length) {
    console.warn(`⚠️  ${region}: геометрия не найдена`);
    return null;
  }

  const gj = osmtogeojson(osmJson);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(gj));
  await sleep(delay); // пауза, чтобы не ушатать Overpass
  return gj;
}

function convertToSvg(fc, { width = 1000, height = 600 } = {}) {
  const projection = geoMercator().precision(0.1).fitSize([width, height], fc);
  const pathGen = geoPath().projection(projection);
  const paths = fc.features
    .map((f) => `<path d="${pathGen(f)}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" stroke="#000" stroke-width="0.3" fill="#ccc">
${paths}
</svg>`;
}

/**********************  ENTRYPOINT  **************************/

(async () => {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const idxC = args.indexOf("--concurrency");
  const concurrency = idxC !== -1 ? Number(args[idxC + 1] || 4) : 4;
  const idxOut = args.indexOf("--out-dir");
  const OUT_DIR =
    idxOut !== -1 ? path.resolve(args[idxOut + 1] || "./svg_regions") : DEFAULT_OUT_DIR;

  await fs.mkdir(OUT_DIR, { recursive: true });

  const limit = pLimit(concurrency);
  const manifest = [];

  const results = await Promise.all(
    SUBJECTS.map((region) =>
      limit(async () => {
        const gj = await fetchRegion(region, { refresh });
        if (!gj) return null;
        const svg = convertToSvg(gj);
        const filename = `${slugify(region)}.svg`;
        await fs.writeFile(path.join(OUT_DIR, filename), svg, "utf8");
        manifest.push({ region, file: filename });
        console.log(`✅  ${region} → ${filename}`);
        return true;
      })
    )
  );

  // manifest.json пригодится для импорта «по имени»
  await fs.writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  console.log(
    `🎉  Готово: ${manifest.length}/${SUBJECTS.length} регионов выгружено в ${OUT_DIR}`
  );

  // exit code 1, если хотя бы один регион не скачан
  if (results.some((r) => !r)) process.exit(1);
})();
