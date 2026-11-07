    // ── Locale ─────────────────────────────────────────────────────────────
    // The dictionaries are data, not source: one JSON file per language under
    // assets/i18n/, inlined by scripts/build-client.mjs as DICTS[code].
    //
    //   settings  the named keys the settings page asks t() for; registered with
    //             DSH's own locale service, one table per language
    //   panel     the Chinese labels the panel draws, each mapped to its line in
    //             that language. 中文 has no panel section: the key already is
    //             the text, which is why editing a label never breaks a lookup.
    //
    // scripts/check-i18n.mjs holds the files against each other — same keys, same
    // placeholders, a langCode that matches the file name — and the build fails
    // rather than shipping a language with a hole in it.
    const DICTS = /* @inline assets/i18n/*.json */ {};
    const LANGS = Object.keys(DICTS).sort();
    const ZH = DICTS.zh.settings;
    const EN = DICTS.en.settings;

    /** What the locale service receives: one table per language, keyed by code. */
    const LOCALE_TABLES = Object.fromEntries(LANGS.map((code) => [code, DICTS[code].settings]));

    /**
     * The language a code names, or "" when it names none of ours.
     *
     * `zh-CN` and `zh_CN` are Chinese; `en-GB` is English; `pt-BR` is nothing,
     * because there is no Portuguese table to draw from. Answering "" lets a
     * caller keep its own default instead of rendering a dictionary it does not
     * have — the difference between falling back to English and showing 中文 to a
     * Russian user.
     *
     * @param {unknown} value a language code, from DSH or from a window's URL
     * @returns {string} one of LANGS, or ""
     */
    function normalizeLang(value) {
      const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, "-") : "";
      // 繁體中文 — DSH has no 繁體 switch of its own, so the codes that reach the
      // panel are zh-TW / zh-HK / zh-MO / zh-Hant, from the plugin's own override or
      // from a detached window's URL. They all mean the one traditional table.
      if (/^zh-(hant|tw|hk|mo)(-|$)/.test(raw) && LANGS.includes("zh-hant")) return "zh-hant";
      const base = raw.split("-")[0];
      return LANGS.includes(base) ? base : "";
    }
