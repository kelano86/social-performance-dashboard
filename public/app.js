/* Social Performance Dashboard.
   No build step and no chart library: everything is hand-rolled SVG so there is
   nothing to drift or re-bundle. */

(function () {
  "use strict";

  var KEY_STORE = "spd-dash-key";
  // Per-browser view memory. A stale value (an old tab name, say) falls back.
  var TAB_STORE = "spd-dash-tab", PLATFORM_STORE = "spd-dash-platform", HOOK_VIEW_STORE = "spd-dash-hook-view";
  var SERIES = {
    youtube: { label: "YouTube", color: "#3987e5" },
    instagram: { label: "Instagram", color: "#d95926" },
    combined: { label: "Both platforms", color: "#199e70" },
    // Views per day, Followers vs non-followers mode. Labels follow the platform switch.
    followers: { label: "From followers", color: "#c98500" },
    nonFollowers: { label: "From everyone else", color: "#199e70" }
  };

  var state = { data: null, tab: "overview", contentFilter: "all", range: 30, mode: "split", sort: {},
    growth: { preset: 30, from: null, to: null },
    // Overview platform switch: combined | instagram | youtube.
    platform: "combined",
    // Hook strength card: its own range, the platform under All, bars or scatter.
    hook: { range: 90, platform: "instagram", view: "bars" },
    // View snapshots: Top videos window, open drop-down rows per table, fetched series.
    gainWindow: "1", open: {}, cache: {}, posts: null };

  // ---------------------------------------------------------------- helpers
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function compact(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }
  function full(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("en-GB");
  }
  function pct(n, dp) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return n.toFixed(dp === undefined ? 1 : dp) + "%";
  }
  function secs(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    if (n < 60) return n.toFixed(1) + "s";
    var m = Math.floor(n / 60);
    return m + "m " + Math.round(n - m * 60) + "s";
  }
  function shortDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + "T00:00:00Z");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  }
  function signed(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return (n > 0 ? "+" : "") + full(n);
  }
  // An instant (ISO or ms) in the viewer's time, e.g. "27 Aug, 09:00".
  function stamp(v, withTime, withYear) {
    var d = new Date(v);
    if (v === null || v === undefined || isNaN(d)) return "—";
    var o = { day: "numeric", month: "short" };
    if (withYear) o.year = "numeric";
    if (withTime) { o.hour = "2-digit"; o.minute = "2-digit"; }
    return d.toLocaleString("en-GB", o);
  }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function svgEl(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    return el;
  }
  function emptyState(host, msg) {
    host.innerHTML = '<div class="empty">' + esc(msg || "No data") + "</div>";
  }
  // Charts are drawn at their host's own pixel width (and a fixed height), so
  // axis text stays at its CSS size on a phone and in narrow grid cards. They
  // are only drawn while their tab is visible, when that width is real.
  function chartWidth(host) {
    return Math.max(260, Math.min(1200, host.clientWidth || 900));
  }
  function stored(key, allowed, fallback) {
    var v = null;
    try { v = localStorage.getItem(key); } catch (e) { /* storage blocked */ }
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }
  function store(key, v) {
    try { localStorage.setItem(key, v); } catch (e) { /* storage blocked */ }
  }
  // Chip groups: one active chip, mirrored in aria-pressed for screen readers.
  function pressChip(group, attr, value) {
    $$(".chip", group).forEach(function (c) {
      var on = c.getAttribute(attr) === String(value);
      c.classList.toggle("is-active", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // ---------------------------------------------------------------- tooltip
  var tip = $("#tip");
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var left = x + 16;
    var top = y - r.height / 2;
    if (left + r.width > window.innerWidth - 12) left = x - r.width - 16;
    if (top < 8) top = 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function hideTip() { tip.hidden = true; }

  function tipRow(color, label, value) {
    return '<div class="tip-row"><span class="tip-key">' +
      (color ? '<span class="legend-swatch" style="background:' + color + '"></span>' : "") +
      esc(label) + '</span><span class="tip-val">' + esc(value) + "</span></div>";
  }

  // ---------------------------------------------------------------- tiles
  function renderTiles(host, tiles) {
    host.innerHTML = tiles.map(function (t) {
      return '<div class="tile">' +
        '<div class="tile-value">' + esc(t.value) + "</div>" +
        '<div class="tile-cap">' + esc(t.cap) + "</div>" +
        (t.sub ? '<div class="tile-sub">' + esc(t.sub) + "</div>" : "") +
        "</div>";
    }).join("");
  }

  function renderLegend(host, keys) {
    host.innerHTML = keys.map(function (k) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' +
        SERIES[k].color + '"></span>' + SERIES[k].label + "</span>";
    }).join("");
  }

  // ---------------------------------------------------------------- line chart
  // One shared y-axis on purpose. A second scale would let two different view
  // definitions look comparable when they are not.
  function renderLine(host, points, seriesKeys, opts) {
    opts = opts || {};
    host.innerHTML = "";
    var usable = points.filter(function (p) {
      return seriesKeys.some(function (k) { return p[k] !== null && p[k] !== undefined; });
    });
    if (usable.length < 2) { emptyState(host, "Not enough daily data yet"); return; }

    var W = chartWidth(host), narrow = W < 600;
    var H = opts.height || (narrow ? 220 : 300), ml = narrow ? 44 : 56, mr = 18, mt = 16, mb = 34;
    var iw = W - ml - mr, ih = H - mt - mb;

    var max = 0;
    usable.forEach(function (p) {
      seriesKeys.forEach(function (k) { if (p[k] > max) max = p[k]; });
    });
    if (max <= 0) max = 1;
    var niceMax = niceCeil(max);

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    var x = function (i) { return ml + (iw * i) / (usable.length - 1); };
    var y = function (v) { return mt + ih - (ih * v) / niceMax; };

    // gridlines + y labels
    for (var t = 0; t <= 4; t++) {
      var v = (niceMax / 4) * t;
      var gy = y(v);
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: gy, y2: gy, class: t === 0 ? "baseline" : "gridline" }));
      var lbl = svgEl("text", { x: ml - 10, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      lbl.textContent = compact(v);
      svg.appendChild(lbl);
    }

    // x labels: first, middle, last
    [0, Math.floor((usable.length - 1) / 2), usable.length - 1].forEach(function (i, n, arr) {
      if (arr.indexOf(i) !== n) return;
      var tx = svgEl("text", {
        x: x(i), y: H - 10,
        "text-anchor": i === 0 ? "start" : i === usable.length - 1 ? "end" : "middle",
        class: "axis-label"
      });
      tx.textContent = shortDate(usable[i].date);
      svg.appendChild(tx);
    });

    // series paths, drawn with gaps where a platform reported nothing
    seriesKeys.forEach(function (k) {
      var d = "", open = false, count = 0;
      usable.forEach(function (p, i) {
        var v = p[k];
        if (v === null || v === undefined) { open = false; return; }
        count++;
        d += (open ? " L " : " M ") + x(i).toFixed(2) + " " + y(v).toFixed(2);
        open = true;
      });
      if (!count) return;
      svg.appendChild(svgEl("path", {
        d: d.trim(), fill: "none", stroke: SERIES[k].color,
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"
      }));
    });

    // crosshair + hit layer
    var cross = svgEl("line", { y1: mt, y2: mt + ih, class: "gridline", opacity: 0 });
    cross.style.stroke = "#8e8e93";
    svg.appendChild(cross);
    var dots = seriesKeys.map(function (k) {
      var c = svgEl("circle", { r: 4.5, fill: SERIES[k].color, stroke: "#1c1c1e", "stroke-width": 2, opacity: 0 });
      svg.appendChild(c);
      return { key: k, el: c };
    });

    var hit = svgEl("rect", { x: ml, y: mt, width: iw, height: ih, fill: "transparent" });
    svg.appendChild(hit);

    hit.addEventListener("mousemove", function (ev) {
      var box = svg.getBoundingClientRect();
      var rel = ((ev.clientX - box.left) / box.width) * W;
      var i = Math.round(((rel - ml) / iw) * (usable.length - 1));
      i = Math.max(0, Math.min(usable.length - 1, i));
      var p = usable[i];
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 0.45);
      var rows = "";
      dots.forEach(function (d) {
        var v = p[d.key];
        if (v === null || v === undefined) { d.el.setAttribute("opacity", 0); return; }
        d.el.setAttribute("cx", x(i)); d.el.setAttribute("cy", y(v)); d.el.setAttribute("opacity", 1);
        rows += tipRow(SERIES[d.key].color, SERIES[d.key].label, full(v));
      });
      if (!rows) rows = tipRow(null, "No data", "—");
      showTip('<div class="tip-title">' + esc(shortDate(p.date)) + "</div>" + rows, ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () {
      cross.setAttribute("opacity", 0);
      dots.forEach(function (d) { d.el.setAttribute("opacity", 0); });
      hideTip();
    });

    host.appendChild(svg);
  }

  // ---------------------------------------------------------------- growth combo
  // Daily net-follower bars against the follower-level line, one panel per
  // platform (their scales differ by two orders of magnitude). Bars read on the
  // right axis, the line on the left: two different measures, so two axes are
  // honest here where they would not be for two view definitions.
  function renderGrowthCombo(host, points, key, opts) {
    opts = opts || {};
    host.innerHTML = "";
    var pts = points.filter(function (p) { return p[key] !== null && p[key] !== undefined; });
    if (pts.length < 2) { emptyState(host, "Not enough follower history in this window"); return; }

    var color = SERIES[key].color;
    var W = chartWidth(host), narrow = W < 600;
    var H = opts.height || (narrow ? 150 : 170), ml = narrow ? 44 : 52, mr = narrow ? 40 : 52, mt = 14, mb = 30;
    var iw = W - ml - mr, ih = H - mt - mb;

    // Level axis: zoom to the observed band rather than starting at zero, or a
    // line of a few thousand followers moving by a few dozen a day would read
    // as perfectly flat.
    var lo = Infinity, hi = -Infinity, netMax = 0;
    pts.forEach(function (p) {
      if (p[key] < lo) lo = p[key];
      if (p[key] > hi) hi = p[key];
      var n = Math.abs(p.net || 0);
      if (n > netMax) netMax = n;
    });
    var pad = Math.max(1, (hi - lo) * 0.15);
    // Round the axis to a nice step so the labels land on whole, even values.
    var step = niceCeil(Math.max(1, (hi - lo + 2 * pad) / 3));
    var yMin = Math.max(0, Math.floor((lo - pad) / step) * step);
    var yMax = Math.ceil((hi + pad) / step) * step;
    if (yMax <= yMin) yMax = yMin + step;
    var tickCount = Math.round((yMax - yMin) / step);
    var hasNeg = pts.some(function (p) { return (p.net || 0) < 0; });
    var netTop = niceCeil(netMax || 1);
    // Bars take the lower two thirds of the plot so the line stays legible above them.
    var barBand = ih * 0.66;
    var zeroY = hasNeg ? mt + ih - barBand / 2 : mt + ih;
    var netScale = (hasNeg ? barBand / 2 : barBand) / netTop;

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    var slot = iw / pts.length;
    var xc = function (i) { return ml + slot * (i + 0.5); };
    var yl = function (v) { return mt + ih - (ih * (v - yMin)) / (yMax - yMin); };

    // level gridlines + left labels
    for (var t = 0; t <= tickCount; t++) {
      var v = yMin + step * t;
      var gy = yl(v);
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: gy, y2: gy, class: t === 0 ? "baseline" : "gridline" }));
      var lbl = svgEl("text", { x: ml - 10, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      lbl.textContent = compact(v);
      svg.appendChild(lbl);
    }
    // right labels for the bar scale
    [netTop, hasNeg ? -netTop : 0].forEach(function (v) {
      var ry = zeroY - v * netScale;
      var rl = svgEl("text", { x: W - mr + 10, y: ry + 3.5, "text-anchor": "start", class: "axis-label" });
      rl.textContent = (v > 0 ? "+" : "") + compact(v);
      rl.style.fill = color;
      svg.appendChild(rl);
    });
    if (hasNeg) {
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: zeroY, y2: zeroY, class: "gridline" }));
    }

    // x labels: first, middle, last
    [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach(function (i, n, arr) {
      if (arr.indexOf(i) !== n) return;
      var tx = svgEl("text", {
        x: xc(i), y: H - 8,
        "text-anchor": i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle",
        class: "axis-label"
      });
      tx.textContent = shortDate(pts[i].date);
      svg.appendChild(tx);
    });

    // bars: net change per day
    var bw = Math.max(2, Math.min(22, slot * 0.6));
    var baseOpacity = function (n) { return n < 0 ? 0.55 : 0.38; };
    var bars = pts.map(function (p, i) {
      var n = p.net;
      if (n === null || n === undefined) return null;
      var h = Math.abs(n) * netScale;
      var y = n >= 0 ? zeroY - h : zeroY;
      var r = svgEl("rect", {
        x: xc(i) - bw / 2, y: y, width: bw, height: Math.max(n === 0 ? 0 : 1.5, h), rx: 2,
        fill: color, opacity: baseOpacity(n)
      });
      svg.appendChild(r);
      return r;
    });

    // line: follower level
    var d = "";
    pts.forEach(function (p, i) { d += (i ? " L " : "M ") + xc(i).toFixed(2) + " " + yl(p[key]).toFixed(2); });
    svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round" }));

    // crosshair + tooltip
    var cross = svgEl("line", { y1: mt, y2: mt + ih, class: "gridline", opacity: 0 });
    cross.style.stroke = "#8e8e93";
    svg.appendChild(cross);
    var dot = svgEl("circle", { r: 4.5, fill: color, stroke: "#1c1c1e", "stroke-width": 2, opacity: 0 });
    svg.appendChild(dot);
    var hit = svgEl("rect", { x: ml, y: mt, width: iw, height: ih, fill: "transparent" });
    svg.appendChild(hit);
    var lastI = -1;
    hit.addEventListener("mousemove", function (ev) {
      var box = svg.getBoundingClientRect();
      var rel = ((ev.clientX - box.left) / box.width) * W;
      var i = Math.floor((rel - ml) / slot);
      i = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[i];
      cross.setAttribute("x1", xc(i)); cross.setAttribute("x2", xc(i)); cross.setAttribute("opacity", 0.45);
      dot.setAttribute("cx", xc(i)); dot.setAttribute("cy", yl(p[key])); dot.setAttribute("opacity", 1);
      if (lastI !== i) {
        bars.forEach(function (b, j) { if (b) b.setAttribute("opacity", j === i ? 0.9 : baseOpacity(pts[j].net)); });
        lastI = i;
      }
      var net = p.net;
      var netLabel = typeof opts.netLabel === "function" ? opts.netLabel(p) : opts.netLabel;
      showTip('<div class="tip-title">' + esc(shortDate(p.date)) + "</div>" +
        tipRow(color, SERIES[key].label, full(p[key])) +
        tipRow(null, netLabel || "Net change", net === null || net === undefined ? "\u2014" : (net > 0 ? "+" : "") + full(net)) +
        (opts.extra ? opts.extra(p) : "") +
        sourceRow(opts, p),
        ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () {
      cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0);
      bars.forEach(function (b, j) { if (b) b.setAttribute("opacity", baseOpacity(pts[j].net)); });
      lastI = -1;
      hideTip();
    });

    host.appendChild(svg);
  }

  function sourceRow(opts, p) {
    var src = opts.source ? opts.source(p) : p.measured ? null : "Reconstructed";
    return src ? tipRow(null, "Source", src) : "";
  }

  // Small multiples of the combo above, with a per-panel summary of the window:
  // net gained over the window and the average per day.
  function renderGrowthPanels(host, points, seriesKeys) {
    host.innerHTML = "";
    seriesKeys.forEach(function (k) {
      var vals = points.filter(function (p) { return p[k] !== null && p[k] !== undefined; });
      var latest = vals.length ? vals[vals.length - 1][k] : null;
      // Window total = the sum of its bars, so header, bars and line agree.
      var delta = null, days = 0;
      vals.forEach(function (p) {
        var n = p.net ? p.net[k] : null;
        if (n === null || n === undefined) return;
        delta = (delta || 0) + n; days++;
      });
      days = Math.max(1, days);
      var wrap = document.createElement("div");
      wrap.className = "sm-panel";
      var head = document.createElement("div");
      head.className = "sm-head";
      head.innerHTML =
        '<span class="sm-title"><span class="legend-swatch" style="background:' +
        SERIES[k].color + '"></span>' + SERIES[k].label + "</span>" +
        '<span class="sm-value">' + full(latest) +
        (delta === null ? "" : ' <span class="sm-delta ' + (delta < 0 ? "is-neg" : "") + '">' +
          (delta > 0 ? "+" : "") + full(delta) + " \u00b7 " + (delta / days > 0 ? "+" : "") + (delta / days).toFixed(1) + "/day</span>") +
        "</span>";
      wrap.appendChild(head);
      var plot = document.createElement("div");
      plot.className = "sm-plot";
      wrap.appendChild(plot);
      host.appendChild(wrap);
      renderGrowthCombo(plot, vals.map(function (p) {
        var o = { date: p.date, net: p.net ? p.net[k] : null, measured: !!(p.measured && p.measured[k]) };
        o[k] = p[k];
        return o;
      }), k, growthTipOpts(k));
    });
  }

  // The per-day follower charts the old platform tabs had live on in this
  // tooltip: YouTube's gained and lost, and Instagram's new followers as
  // reported (gross adds), next to the net change the bars show.
  function growthTipOpts(k) {
    if (k === "youtube") {
      return {
        netLabel: "Net subscribers",
        extra: function (p) {
          var s = state.subsByDate && state.subsByDate[p.date];
          return s ? tipRow(null, "Gained", "+" + full(s.gained)) +
            tipRow(null, "Lost", s.lost ? "\u2212" + full(s.lost) : "0") : "";
        }
      };
    }
    return {
      // Measured days are a true net: Instagram's own follows minus unfollows,
      // or the difference between two snapshots. Elsewhere the bars are gross adds.
      netLabel: function (p) { return p.measured ? "Net followers" : "New followers"; },
      extra: function (p) {
        var r = state.igNet && state.igNet[p.date];
        if (r) {
          return tipRow(null, "Follows", "+" + full(r.follows)) +
            tipRow(null, "Unfollows", r.unfollows ? "\u2212" + full(r.unfollows) : "0");
        }
        var n = state.igAddsByDate && state.igAddsByDate[p.date];
        return p.measured && n !== null && n !== undefined ? tipRow(null, "New followers (gross)", "+" + full(n)) : "";
      },
      source: function (p) {
        if (state.igNet && state.igNet[p.date]) return "Measured: follows \u2212 unfollows";
        return p.measured ? null : "Reconstructed";
      }
    };
  }

  /**
   * Retention curve: share still watching against elapsed position. Unlike the
   * other line charts the x axis is video position, not time, so it gets its own
   * renderer rather than bending renderLine into a shape it does not fit. Drawn
   * in a YouTube row's drop-down on the Content tab.
   */
  function renderRetention(host, curve) {
    host.innerHTML = "";
    if (!curve || !curve.points || curve.points.length < 2) {
      emptyState(host, "No retention data for this video");
      return;
    }
    var pts = curve.points.filter(function (p) { return p.elapsed !== null && p.watchRatio !== null; });
    if (pts.length < 2) { emptyState(host, "No retention data for this video"); return; }

    var W = chartWidth(host), narrow = W < 600;
    var H = narrow ? 210 : 240, ml = narrow ? 44 : 52, mr = 14, mt = 14, mb = 30;
    var iw = W - ml - mr, ih = H - mt - mb;
    var maxY = Math.max(1.1, Math.max.apply(null, pts.map(function (p) { return p.watchRatio; })));
    var niceMax = Math.ceil(maxY * 10) / 10;

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    var x = function (r) { return ml + iw * r; };
    var y = function (v) { return mt + ih - (ih * v) / niceMax; };

    for (var t = 0; t <= 4; t++) {
      var v = (niceMax / 4) * t;
      var gy = y(v);
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: gy, y2: gy, class: t === 0 ? "baseline" : "gridline" }));
      var lab = svgEl("text", { x: ml - 10, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      lab.textContent = Math.round(v * 100) + "%";
      svg.appendChild(lab);
    }
    // 100% reference: everyone still watching
    var oneY = y(1);
    var ref = svgEl("line", { x1: ml, x2: W - mr, y1: oneY, y2: oneY, stroke: "#8e8e93", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.55 });
    svg.appendChild(ref);

    [0, 0.25, 0.5, 0.75, 1].forEach(function (r) {
      var tx = svgEl("text", {
        x: x(r), y: H - 9,
        "text-anchor": r === 0 ? "start" : r === 1 ? "end" : "middle",
        class: "axis-label"
      });
      tx.textContent = Math.round(r * 100) + "%";
      svg.appendChild(tx);
    });

    var d = pts.map(function (p, i) {
      return (i ? "L " : "M ") + x(p.elapsed).toFixed(2) + " " + y(p.watchRatio).toFixed(2);
    }).join(" ");
    svg.appendChild(svgEl("path", {
      d: d, fill: "none", stroke: SERIES.youtube.color,
      "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"
    }));

    var dot = svgEl("circle", { r: 4.5, fill: SERIES.youtube.color, stroke: "#1c1c1e", "stroke-width": 2, opacity: 0 });
    var cross = svgEl("line", { y1: mt, y2: mt + ih, stroke: "#8e8e93", "stroke-width": 1, opacity: 0 });
    svg.appendChild(cross); svg.appendChild(dot);

    var hit = svgEl("rect", { x: ml, y: mt, width: iw, height: ih, fill: "transparent" });
    svg.appendChild(hit);
    hit.addEventListener("mousemove", function (ev) {
      var box = svg.getBoundingClientRect();
      var rel = ((ev.clientX - box.left) / box.width) * W;
      var ratio = Math.max(0, Math.min(1, (rel - ml) / iw));
      var i = Math.round(ratio * (pts.length - 1));
      var p = pts[i];
      cross.setAttribute("x1", x(p.elapsed)); cross.setAttribute("x2", x(p.elapsed)); cross.setAttribute("opacity", 0.45);
      dot.setAttribute("cx", x(p.elapsed)); dot.setAttribute("cy", y(p.watchRatio)); dot.setAttribute("opacity", 1);
      showTip('<div class="tip-title">' + Math.round(p.elapsed * 100) + "% through</div>" +
        tipRow(SERIES.youtube.color, "Still watching", Math.round(p.watchRatio * 100) + "%") +
        (p.relative !== null ? tipRow(null, "vs similar videos", p.relative.toFixed(2) + "x") : ""),
        ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () {
      cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip();
    });

    host.appendChild(svg);
  }

  function niceCeil(v) {
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  // ---------------------------------------------------------------- bar chart
  // Horizontal bars for a ranked breakdown (countries, ages, traffic sources):
  // one row per category, so it never grows with posts or days.
  function renderBars(host, rows, opts) {
    opts = opts || {};
    host.innerHTML = "";
    if (!rows || !rows.length) { emptyState(host, opts.emptyMsg || "No data"); return; }

    var color = opts.color || "#3987e5";
    var fmt = opts.format || full;
    var W = chartWidth(host);
    var rowH = 22, gap = 9, mr = 52;
    // Label column sized to the longest label (roughly 6.4px a character),
    // capped so the bars keep most of a narrow card.
    var longest = Math.max.apply(null, rows.map(function (r) { return String(r.label).length; }));
    var ml = Math.round(Math.min(opts.labelWidth || 150, W * 0.4, Math.max(36, longest * 6.4 + 18)));
    var H = rows.length * (rowH + gap) - gap + 8;
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    if (max <= 0) max = 1;
    var iw = W - ml - mr;
    var maxChars = Math.max(6, Math.floor((ml - 10) / 6.4));

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });

    rows.forEach(function (r, i) {
      var y = i * (rowH + gap) + 4;
      var w = Math.max(2, (iw * r.value) / max);

      var label = svgEl("text", { x: 0, y: y + rowH / 2 + 4, class: "bar-label" });
      label.textContent = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + "\u2026" : r.label;
      svg.appendChild(label);

      // 4px rounded data-end, anchored flat to the baseline
      svg.appendChild(svgEl("rect", { x: ml, y: y, width: w, height: rowH, rx: 4, fill: color }));
      if (w > 6) svg.appendChild(svgEl("rect", { x: ml, y: y, width: 4, height: rowH, fill: color }));

      var val = svgEl("text", { x: ml + w + 8, y: y + rowH / 2 + 4, class: "value-label" });
      val.textContent = fmt(r.value);
      svg.appendChild(val);

      var hit = svgEl("rect", { x: 0, y: y - gap / 2, width: W, height: rowH + gap, fill: "transparent" });
      hit.addEventListener("mousemove", function (ev) {
        showTip('<div class="tip-title">' + esc(r.label) + "</div>" +
          tipRow(color, opts.metricLabel || "Value", fmt(r.value)), ev.clientX, ev.clientY);
      });
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  }

  // ---------------------------------------------------------------- hook strength
  // One number per post for how well its opening holds viewers; taller is
  // better on both platforms. Instagram's API exposes no retention curve, only
  // the share who skipped inside 3 seconds, so its measure is the share who
  // stayed. YouTube's per-video figure is average percentage viewed.
  var HOOK = {
    instagram: {
      short: "Stayed past 3s",
      axis: "% stayed past 3s",
      metric: "Share of viewers who stayed past the first 3 seconds (100 minus Instagram’s skip rate).",
      get: function (r) { return r.skipRate === null || r.skipRate === undefined ? null : 100 - r.skipRate; }
    },
    youtube: {
      short: "Avg % viewed",
      axis: "Avg % viewed",
      metric: "Average percentage of the video watched per view. Shorts pass 100% when viewers loop.",
      get: function (r) { return r.avgViewPercent === null || r.avgViewPercent === undefined ? null : r.avgViewPercent; }
    }
  };

  function median(vals) {
    var v = vals.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function hookTip(row, key) {
    var p = row.post;
    return '<div class="tip-title tip-wrap">' + esc(p.title || p.id) + "</div>" +
      tipRow(null, "Posted", shortDate(p.date)) +
      tipRow(SERIES[key].color, HOOK[key].short, pct(row.value)) +
      (key === "instagram" ? tipRow(null, "Skip rate", pct(p.skipRate)) : "") +
      tipRow(null, "Views", full(p.views));
  }

  // Frame shared by both views: a fixed 240px plot whose y axis runs 0-100%,
  // raised in 25s when a looping Short averages past 100%.
  function hookFrame(host, rows, key) {
    var W = chartWidth(host), narrow = W < 600;
    var max = 0;
    rows.forEach(function (r) { if (r.value > max) max = r.value; });
    var f = { W: W, H: 240, ml: narrow ? 40 : 46, mr: 10, mt: 24, mb: 26, narrow: narrow };
    f.top = Math.max(100, Math.ceil(max / 25) * 25);
    f.iw = W - f.ml - f.mr;
    f.ih = f.H - f.mt - f.mb;
    f.y = function (v) { return f.mt + f.ih - (f.ih * Math.max(0, v)) / f.top; };
    f.svg = svgEl("svg", { viewBox: "0 0 " + W + " " + f.H, role: "img" });
    for (var v = 0; v <= f.top; v += 25) {
      var gy = f.y(v);
      f.svg.appendChild(svgEl("line", { x1: f.ml, x2: W - f.mr, y1: gy, y2: gy, class: v === 0 ? "baseline" : "gridline" }));
      var lbl = svgEl("text", { x: f.ml - 8, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      lbl.textContent = v + "%";
      f.svg.appendChild(lbl);
    }
    if (f.top > 100) {
      f.svg.appendChild(svgEl("line", { x1: f.ml, x2: W - f.mr, y1: f.y(100), y2: f.y(100), stroke: "#8e8e93",
        "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.55 }));
    }
    var title = svgEl("text", { x: 0, y: 10, class: "axis-label" });
    title.textContent = HOOK[key].axis;
    f.svg.appendChild(title);
    return f;
  }

  // Median of the posts shown, dashed, labelled at its right end.
  function hookMedian(f, rows) {
    var med = median(rows.map(function (r) { return r.value; }));
    var my = f.y(med);
    f.svg.appendChild(svgEl("line", { x1: f.ml, x2: f.W - f.mr, y1: my, y2: my, stroke: "#c8c0b0",
      "stroke-width": 1.25, "stroke-dasharray": "5 4", opacity: 0.85, "pointer-events": "none" }));
    var t = svgEl("text", { x: f.W - f.mr - 2, y: my - 5, "text-anchor": "end", class: "axis-label hook-median" });
    t.textContent = "Median " + pct(med, 0);
    f.svg.appendChild(t);
  }

  /**
   * Vertical bars, one per post, oldest to newest by publish date. Each post
   * gets an equal slot across a fixed width and height, so the chart never
   * grows: as posts accumulate the gaps shrink first, then the bars, never
   * below 2px wide. Clicking a bar calls onPick with its post.
   */
  function renderHookBars(host, rows, key, onPick) {
    host.innerHTML = "";
    var f = hookFrame(host, rows, key);
    var svg = f.svg, color = SERIES[key].color, n = rows.length;
    svg.setAttribute("aria-label", HOOK[key].axis + " for " + n + " posts, oldest to newest");
    var slot = f.iw / n;
    var bw = Math.min(24, Math.max(2, slot - Math.min(4, slot * 0.25)));
    var xc = function (i) { return f.ml + slot * (i + 0.5); };
    var base = f.y(0);
    var baseOpacity = 0.85;
    var bars = rows.map(function (r, i) {
      var top = f.y(r.value);
      var b = svgEl("rect", { x: xc(i) - bw / 2, y: top, width: bw, height: Math.max(1, base - top),
        rx: bw >= 8 ? 2 : 0, fill: color, opacity: baseOpacity });
      svg.appendChild(b);
      return b;
    });

    // Date ticks, evenly spaced through the posts; the year joins in when the
    // range crosses one.
    var multiYear = rows[0].post.date.slice(0, 4) !== rows[n - 1].post.date.slice(0, 4);
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(f.iw / (multiYear ? 96 : 70)))));
    var prev = "";
    for (var i = 0; i < n; i += every) {
      var date = rows[i].post.date;
      var lab = shortDate(date) + (multiYear ? " " + date.slice(0, 4) : "");
      if (lab === prev) continue;
      prev = lab;
      var tx = xc(i), half = lab.length * 3.3;
      svg.appendChild(svgEl("line", { x1: tx, x2: tx, y1: base, y2: base + 4, class: "baseline" }));
      var t = svgEl("text", { x: Math.max(half, Math.min(f.W - half, tx)), y: f.H - 8, "text-anchor": "middle", class: "axis-label" });
      t.textContent = lab;
      svg.appendChild(t);
    }
    hookMedian(f, rows);

    var hit = svgEl("rect", { x: f.ml, y: f.mt, width: f.iw, height: f.ih, fill: "transparent", class: "hook-hit" });
    svg.appendChild(hit);
    var at = function (ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.clientX - box.left) / box.width) * f.W;
      return Math.max(0, Math.min(n - 1, Math.floor((px - f.ml) / slot)));
    };
    var lit = -1;
    hit.addEventListener("mousemove", function (ev) {
      var i = at(ev);
      if (i !== lit) {
        bars.forEach(function (b, j) { b.setAttribute("opacity", j === i ? 1 : 0.4); });
        lit = i;
      }
      showTip(hookTip(rows[i], key), ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () {
      bars.forEach(function (b) { b.setAttribute("opacity", baseOpacity); });
      lit = -1;
      hideTip();
    });
    hit.addEventListener("click", function (ev) { hideTip(); onPick(rows[at(ev)].post); });
    host.appendChild(svg);
  }

  /**
   * The same measure against views, one dot per post: views on a log scale,
   * since one viral reel would otherwise pin every other post to the axis.
   * Clicking a dot calls onPick with its post.
   */
  function renderHookScatter(host, rows, key, onPick) {
    host.innerHTML = "";
    var f = hookFrame(host, rows, key);
    var svg = f.svg, color = SERIES[key].color;
    svg.setAttribute("aria-label", HOOK[key].axis + " against views for " + rows.length + " posts");
    var lv = function (v) { return Math.log10(Math.max(1, v || 0)); };
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (r) { var l = lv(r.post.views); if (l < lo) lo = l; if (l > hi) hi = l; });
    var d0 = Math.floor(lo), d1 = Math.ceil(hi);
    if (d1 <= d0) d1 = d0 + 1;
    var pad = 10;
    var x = function (v) { return f.ml + pad + ((f.iw - 2 * pad) * (lv(v) - d0)) / (d1 - d0); };
    var base = f.y(0);
    for (var k = d0; k <= d1; k++) {
      var gx = x(Math.pow(10, k));
      svg.appendChild(svgEl("line", { x1: gx, x2: gx, y1: f.mt, y2: base, class: "gridline" }));
      var t = svgEl("text", { x: gx, y: f.H - 8, "text-anchor": k === d1 ? "end" : "middle", class: "axis-label" });
      t.textContent = compact(Math.pow(10, k)) + (k === d1 ? " views" : "");
      svg.appendChild(t);
    }
    var xt = svgEl("text", { x: f.W - f.mr, y: 10, "text-anchor": "end", class: "axis-label" });
    xt.textContent = "Views, log scale →";
    svg.appendChild(xt);
    hookMedian(f, rows);

    var r0 = f.narrow ? 4 : 4.5;
    var dots = rows.map(function (r) {
      var c = svgEl("circle", { cx: x(r.post.views), cy: f.y(r.value), r: r0, fill: color, opacity: 0.8,
        stroke: "#1c1c1e", "stroke-width": 1.5 });
      svg.appendChild(c);
      return c;
    });

    var hit = svgEl("rect", { x: f.ml, y: f.mt, width: f.iw, height: f.ih, fill: "transparent", class: "hook-hit" });
    svg.appendChild(hit);
    var nearest = function (ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.clientX - box.left) / box.width) * f.W;
      var py = ((ev.clientY - box.top) / box.height) * f.H;
      var best = -1, bd = 24 * 24;
      dots.forEach(function (c, i) {
        var dx = Number(c.getAttribute("cx")) - px, dy = Number(c.getAttribute("cy")) - py;
        if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = i; }
      });
      return best;
    };
    var lit = -1;
    var light = function (i) {
      if (i === lit) return;
      dots.forEach(function (c, j) {
        c.setAttribute("opacity", i < 0 ? 0.8 : j === i ? 1 : 0.35);
        c.setAttribute("r", j === i ? r0 + 2 : r0);
      });
      lit = i;
    };
    hit.addEventListener("mousemove", function (ev) {
      var i = nearest(ev);
      light(i);
      hit.style.cursor = i < 0 ? "default" : "pointer";
      if (i < 0) hideTip();
      else showTip(hookTip(rows[i], key), ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () { light(-1); hideTip(); });
    hit.addEventListener("click", function (ev) {
      var i = nearest(ev);
      if (i < 0) return;
      hideTip();
      onPick(rows[i].post);
    });
    host.appendChild(svg);
  }

  // ---------------------------------------------------------------- tables
  var COLUMNS = {
    platform: { label: "Platform", get: function (r) { return r.platform; }, type: "tag", align: "left" },
    title: { label: "Title", get: function (r) { return r.title; }, type: "title", align: "left" },
    date: { label: "Date", get: function (r) { return r.date; }, type: "date" },
    format: { label: "Format", get: function (r) { return r.format; }, type: "text" },
    views: { label: "Views", get: function (r) { return r.views; } },
    reach: { label: "Reach", get: function (r) { return r.reach; } },
    likes: { label: "Likes", get: function (r) { return r.likes; } },
    comments: { label: "Comments", get: function (r) { return r.comments; } },
    shares: { label: "Shares", get: function (r) { return r.shares; } },
    saves: { label: "Saves", get: function (r) { return r.saves; } },
    engagement: { label: "Engagement", get: function (r) { return r.engagement; } },
    engRate: {
      label: "Eng %", get: function (r) { return r.views ? (r.engagement / r.views) * 100 : null; },
      type: "pct"
    },
    avgWatchSeconds: { label: "Avg watch", get: function (r) { return r.avgWatchSeconds; }, type: "secs" },
    avgViewPercent: { label: "Avg view %", get: function (r) { return r.avgViewPercent; }, type: "pct" },
    skipRate: { label: "Skip %", get: function (r) { return r.skipRate; }, type: "pct" },
    followsGained: { label: "Follows", get: function (r) { return r.followsGained; } },
    privacy: { label: "Visibility", get: function (r) { return r.privacy; }, type: "text" },
    combinedTitle: {
      label: "Content", type: "combinedTitle", align: "left",
      get: function (r) { return r.title; }
    },
    youtubeViews: { label: "YouTube", get: function (r) { return r.youtubeViews; } },
    instagramViews: { label: "Instagram", get: function (r) { return r.instagramViews; } }
  };

  // The platform button is the only link to a post, so a click anywhere else
  // on a row can open its drop-down instead.
  function platformLink(post) {
    var s = SERIES[post.platform] || { label: post.platform, color: "#8e8e93" };
    var inner = '<span class="tag-dot" style="background:' + s.color + '"></span>' + esc(s.label);
    if (!post.url) return '<span class="tag">' + inner + "</span>";
    return '<a class="tag tag-link" href="' + esc(post.url) + '" target="_blank" rel="noopener" title="Open on ' +
      esc(s.label) + ' (new tab)">' + inner + '<span class="tag-arrow" aria-hidden="true">\u2197</span></a>';
  }

  function cellHtml(col, row, opts) {
    var v = col.get(row);
    if (col.type === "tag") return platformLink(row);
    if (col.type === "title") {
      return '<span class="cell-title">' + esc(v || "Untitled") + "</span>" +
        (opts && opts.pill ? '<span class="cell-pill">' + platformLink(row) + "</span>" : "");
    }
    if (col.type === "combinedTitle") {
      // Naming each piece keeps a wrong same-day pairing visible instead of
      // hidden inside the total.
      var links = row.pieces.map(platformLink).join(" ");
      return esc(v || "Untitled") +
        '<span class="combined-sub">' + links +
        (row.crossPosted ? "" : " one platform only") + "</span>";
    }
    if (v === null || v === undefined || v === "") return '<span class="dim">—</span>';
    if (col.type === "date") return esc(shortDate(v));
    if (col.type === "text") return esc(String(v).toLowerCase());
    if (col.type === "pct") return esc(pct(v));
    if (col.type === "secs") return esc(secs(v));
    return esc(full(v));
  }

  // opts.expand(row, panel) makes rows expandable: a chevron button in the first
  // cell, a click anywhere on the row (other than a link) toggles a drop-down
  // row under it. opts.key(row) names a row so open drop-downs survive a
  // re-sort or a resize.
  function renderTable(host, rows, colKeys, tableId, opts) {
    opts = opts || {};
    if (!rows.length) { emptyState(host, "No content"); return; }

    var sort = state.sort[tableId] || { key: "views", dir: -1 };
    state.sort[tableId] = sort;

    var sorted = rows.slice().sort(function (a, b) {
      var col = COLUMNS[sort.key];
      var av = col.get(a), bv = col.get(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string") return sort.dir * av.localeCompare(bv);
      return sort.dir * (av - bv);
    });

    var head = colKeys.map(function (k) {
      var arrow = sort.key === k ? '<span class="arrow">' + (sort.dir === -1 ? "↓" : "↑") + "</span>" : "";
      return '<th data-col="' + k + '">' + esc(COLUMNS[k].label) + " " + arrow + "</th>";
    }).join("");

    var open = state.open[tableId] || (state.open[tableId] = {});
    var byKey = {};
    var body = sorted.map(function (r) {
      var key = opts.expand ? opts.key(r) : null;
      var cells = colKeys.map(function (k, i) {
        var col = COLUMNS[k];
        var cls = col.type === "title" ? ' class="title-cell"' : "";
        var html = cellHtml(col, r, opts);
        if (key && i === 0) {
          html = '<div class="xp-cell">' + toggleHtml(tableId, key, !!open[key], r) +
            '<div class="xp-cell-body">' + html + "</div></div>";
        }
        return "<td" + cls + ">" + html + "</td>";
      }).join("");
      if (!key) return "<tr>" + cells + "</tr>";
      byKey[key] = r;
      return '<tr class="xp-row' + (open[key] ? " is-open" : "") + '" data-key="' + esc(key) + '">' + cells + "</tr>" +
        (open[key] ? panelRowHtml(tableId, key, colKeys.length) : "");
    }).join("");

    host.classList.toggle("xp-host", !!opts.expand);
    host.innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";

    $$("thead th", host).forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-col");
        if (sort.key === k) sort.dir = -sort.dir;
        else { sort.key = k; sort.dir = -1; }
        renderTable(host, rows, colKeys, tableId, opts);
      });
    });

    if (!opts.expand) return;
    Object.keys(open).forEach(function (key) {
      var panel = byKey[key] && document.getElementById(panelId(tableId, key));
      if (panel) opts.expand(byKey[key], panel);
    });
    $("tbody", host).addEventListener("click", function (ev) {
      if (ev.target.closest("a")) return; // the platform button opens the post
      var tr = ev.target.closest("tr.xp-row");
      if (!tr) return;
      toggleRow(tr, tableId, byKey, colKeys.length, opts);
    });
  }

  function panelId(tableId, key) {
    return "xp-" + tableId + "-" + String(key).replace(/[^A-Za-z0-9_-]/g, "_");
  }
  function toggleHtml(tableId, key, isOpen, row) {
    var label = row.pieces ? "Views gained on " + shortDate(row.date) : "Views over time: " + (row.title || row.id);
    return '<button type="button" class="xp-toggle" aria-expanded="' + isOpen + '" aria-controls="' +
      panelId(tableId, key) + '" aria-label="' + esc(label) + '"><span aria-hidden="true">\u203a</span></button>';
  }
  function panelRowHtml(tableId, key, span) {
    return '<tr class="xp-panel-row"><td colspan="' + span + '"><div class="xp-panel" id="' +
      panelId(tableId, key) + '"></div></td></tr>';
  }
  // Toggled in place rather than re-rendered, so keyboard focus stays on the button.
  function toggleRow(tr, tableId, byKey, span, opts) {
    var key = tr.getAttribute("data-key");
    var open = state.open[tableId];
    var btn = $(".xp-toggle", tr);
    if (open[key]) {
      delete open[key];
      var next = tr.nextElementSibling;
      if (next && next.classList.contains("xp-panel-row")) next.parentNode.removeChild(next);
      tr.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    open[key] = true;
    tr.insertAdjacentHTML("afterend", panelRowHtml(tableId, key, span));
    tr.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    opts.expand(byKey[key], document.getElementById(panelId(tableId, key)));
  }

  // ---------------------------------------------------------------- view snapshots
  // Every refresh records each post's lifetime views (netlify/lib/snapshots.mjs).
  // The overview's windows ride on /api/data; one post's curve and one day's
  // breakdown are fetched from /api/snapshots when a row is opened.
  var WINDOW_LABEL = { 1: "24 hours", 7: "7 days", 14: "14 days", 30: "30 days" };

  function getJSON(cacheKey, url) {
    var c = state.cache;
    if (!c[cacheKey]) {
      c[cacheKey] = fetch(url, { headers: apiHeaders() }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || "request failed (" + res.status + ")");
          return body;
        });
      });
      c[cacheKey].catch(function () { delete c[cacheKey]; });
    }
    return c[cacheKey];
  }

  function postKey(r) { return r.platform + ":" + r.id; }
  function releaseKey(r) { return r.date + "|" + r.pieces.map(function (p) { return p.id; }).join(","); }

  function postIndex() {
    if (!state.posts) {
      state.posts = {};
      (state.data.content || []).forEach(function (c) { state.posts[postKey(c)] = c; });
    }
    return state.posts;
  }

  function shareHtml(share, color) {
    if (share === null || share === undefined || isNaN(share)) return '<span class="dim">—</span>';
    return '<span class="share"><span class="share-bar"><span style="width:' + Math.max(0, Math.min(100, share)).toFixed(1) +
      "%;background:" + color + '"></span></span><span>' + esc(pct(share, share < 10 ? 1 : 0)) + "</span></span>";
  }

  function videoCellHtml(post) {
    var thumb = post.thumbnail
      ? '<img class="gain-thumb" src="' + esc(post.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">'
      : "";
    return '<div class="gain-post">' + thumb + '<div class="gain-text"><span class="gain-title">' +
      esc(post.title || post.id) + '</span><span class="gain-meta">' + platformLink(post) +
      (post.date ? "<span>" + esc(shortDate(post.date)) + "</span>" : "") + "</span></div></div>";
  }

  // Top N by views gained, with each one's share of everything gained in the span.
  function gainTableHtml(rows, total) {
    var posts = postIndex();
    return '<table class="gain-table"><thead><tr><th>Video</th><th>Gained</th><th>Share</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var post = posts[postKey(r)] || { platform: r.platform, id: r.id, title: "Post no longer listed (" + r.id + ")" };
        var color = (SERIES[r.platform] || SERIES.combined).color;
        return '<tr><td class="gain-video">' + videoCellHtml(post) + '</td><td class="gain-num">' + esc(signed(r.gained)) +
          "</td><td>" + shareHtml(total > 0 ? (r.gained / total) * 100 : null, color) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  // Follows the overview's platform switch: both platforms, or one, with each
  // row's share taken of that platform's total.
  function renderGained() {
    var host = $("#ovGained");
    var note = $("#ovGainedNote");
    var snaps = state.data.snapshots;
    var win = snaps && snaps.windows ? snaps.windows[state.gainWindow] : null;
    var one = state.platform === "combined" ? null : state.platform;
    if (!win) {
      emptyState(host, snaps === null
        ? "View snapshots could not be recorded on the last refresh"
        : "Collecting: the first comparison appears once there are two snapshots.");
      note.textContent = snaps && snaps.since
        ? "Tracking since " + stamp(snaps.since, true) + "."
        : "Each refresh records every post's lifetime views. Views gained is the difference between two of those records.";
      return;
    }
    var bp = win.byPlatform || {};
    var total = one ? (bp[one] ? bp[one].totalGained : 0) : win.totalGained;
    var rows = (win.rows || []).filter(function (r) {
      return r.gained > 0 && (!one || r.platform === one);
    }).slice(0, 5);
    if (rows.length) host.innerHTML = gainTableHtml(rows, total);
    else emptyState(host, "No views gained" + (one ? " on " + SERIES[one].label : "") + " in this window");
    note.textContent = gainNote(win, snaps, one);
  }

  function gainNote(win, snaps, one) {
    var bp = win.byPlatform || {};
    var src = one ? (bp[one] || { totalGained: 0, unknown: 0, revised: 0 }) : win;
    var parts = [one
      ? signed(src.totalGained) + " views gained on " + SERIES[one].label + " in the last " + WINDOW_LABEL[win.days] + "."
      : signed(win.totalGained) + " views gained in the last " + WINDOW_LABEL[win.days] +
        " (Instagram " + signed(bp.instagram ? bp.instagram.totalGained : 0) +
        ", YouTube " + signed(bp.youtube ? bp.youtube.totalGained : 0) + ")."];
    // Account-level views include posts outside this list (stories, older
    // posts), so they are a reference, not a check.
    var av = win.accountViews || {};
    var refs = [];
    if (av.instagram && one !== "youtube") refs.push("Instagram " + full(av.instagram.views));
    if (av.youtube && one !== "instagram") {
      refs.push("YouTube " + full(av.youtube.views) +
        (av.instagram && av.youtube.to < av.instagram.to ? " (reported through " + shortDate(av.youtube.to) + ")" : ""));
    }
    if (refs.length) {
      var span = one ? av[one] : av.instagram || av.youtube;
      parts.push("Account views " + (span.from === span.to
        ? "on " + shortDate(span.from) + " (last complete day)"
        : shortDate(span.from) + " to " + shortDate(span.to) + " (complete days)") + ": " + refs.join(", ") + ".");
    }
    if (src.unknown) {
      parts.push(src.unknown + (src.unknown === 1 ? " older post has" : " older posts have") +
        " no earlier snapshot and " + (src.unknown === 1 ? "is" : "are") + " left out.");
    }
    if (src.revised) {
      parts.push(src.revised + (src.revised === 1 ? " count was" : " counts were") +
        " revised down by the platform and count as no gain.");
    }
    parts.push(win.partial
      ? "Partial: since " + stamp(win.from, true) + ", the oldest snapshot, as history is shorter than the window."
      : "Measured from " + stamp(win.from, true) + ".");
    parts.push("Tracking since " + stamp(snaps.since) + ".");
    return parts.join(" ");
  }

  function legendItem(kind, color, label) {
    return '<span class="legend-item"><span class="lg-' + kind + '" style="' +
      (kind === "bar" ? "background:" : "border-color:") + color + '"></span>' + esc(label) + "</span>";
  }

  /**
   * One post's lifetime views against time: the recorded totals as a line, the
   * views gained per day as bars (right axis), and, for a post published before
   * tracking began, a dashed straight-line estimate from 0 at posting to the
   * first recorded total. The x axis is real time, since refreshes are not
   * evenly spaced. Drawn at the panel's own width so labels stay legible on a
   * phone.
   */
  function renderViewCurve(host, series, color) {
    host.innerHTML = "";
    var pts = series.points.map(function (p) { return { t: Date.parse(p.t), v: p.views }; });
    var est = series.estimate
      ? { t0: Date.parse(series.estimate.from.t), v1: series.estimate.to.views }
      : null;
    var daily = (series.daily || []).map(function (d) {
      return { date: d.date, gained: d.gained, partial: d.partial, from: Date.parse(d.from), to: Date.parse(d.to) };
    });

    var W = Math.max(260, Math.min(900, host.clientWidth || 900));
    var narrow = W < 600;
    var H = narrow ? 210 : 240, ml = narrow ? 44 : 56, mr = narrow ? 42 : 52, mt = 14, mb = 30;
    var iw = W - ml - mr, ih = H - mt - mb;

    var tFirst = pts[0].t, tLast = pts[pts.length - 1].t, tracked = tLast - tFirst;
    // The estimate can span months against days of tracking. Linear time would
    // squash the measured part into a sliver, so the estimate gets at most 30%
    // of the width, with an axis break where the scale changes.
    var estW = 0, broken = false;
    if (est) {
      var linear = tracked > 0 ? iw * (tFirst - est.t0) / (tLast - est.t0) : iw;
      estW = tracked > 0 ? Math.min(linear, iw * 0.3) : iw;
      broken = tracked > 0 && estW < linear - 0.5;
    }
    var x = function (t) {
      if (est && t <= tFirst) return ml + (tFirst > est.t0 ? estW * Math.max(0, t - est.t0) / (tFirst - est.t0) : estW);
      return ml + estW + (tracked > 0 ? (iw - estW) * (t - tFirst) / tracked : 0);
    };

    // Level axis: from zero when the curve does (an estimate, or tracked from
    // posting); otherwise zoomed to the observed band like the follower chart.
    var lo = Infinity, hi = 0;
    pts.forEach(function (p) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; });
    var yMin, yMax, step;
    if (est || series.trackedFromPosting) {
      step = niceCeil(Math.max(1, hi) / 4);
      yMin = 0; yMax = step * Math.max(1, Math.ceil((hi * 1.05) / step));
    } else {
      var pad = Math.max(1, (hi - lo) * 0.15);
      step = niceCeil(Math.max(1, (hi - lo + 2 * pad) / 3));
      yMin = Math.max(0, Math.floor((lo - pad) / step) * step);
      yMax = Math.ceil((hi + pad) / step) * step;
      if (yMax <= yMin) yMax = yMin + step;
    }
    var y = function (v) { return mt + ih - (ih * (v - yMin)) / (yMax - yMin); };

    var gMax = 0;
    daily.forEach(function (d) { if (d.gained > gMax) gMax = d.gained; });
    var gTop = niceCeil(gMax || 1), zeroY = mt + ih, gScale = (ih * 0.66) / gTop;

    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Views over time" });
    for (var t = 0, n = Math.round((yMax - yMin) / step); t <= n; t++) {
      var v = yMin + step * t, gy = y(v);
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: gy, y2: gy, class: t === 0 ? "baseline" : "gridline" }));
      var lbl = svgEl("text", { x: ml - 8, y: gy + 3.5, "text-anchor": "end", class: "axis-label" });
      lbl.textContent = compact(v);
      svg.appendChild(lbl);
    }
    [gTop, 0].forEach(function (g) {
      var rl = svgEl("text", { x: W - mr + 8, y: zeroY - g * gScale + 3.5, "text-anchor": "start", class: "axis-label" });
      rl.textContent = g ? "+" + compact(g) : "0";
      rl.style.fill = color;
      svg.appendChild(rl);
    });

    // x labels: posting, tracking start and latest when estimated; else first, middle, last.
    var withTime = !est && tracked < 2 * 86400000;
    var yearOf = function (ms) { return new Date(ms).getFullYear(); };
    var labels = est
      ? [{ t: est.t0, a: "start", year: yearOf(est.t0) !== yearOf(tLast) }]
          .concat(tracked > 0 && estW >= 70 && iw - estW >= 70 ? [{ t: tFirst, a: "middle" }] : [])
          .concat([{ t: tLast, a: "end" }])
      : [{ t: tFirst, a: "start" }, { t: tFirst + tracked / 2, a: "middle" }, { t: tLast, a: "end" }];
    labels.forEach(function (l) {
      var tx = svgEl("text", { x: x(l.t), y: H - 9, "text-anchor": l.a, class: "axis-label" });
      tx.textContent = stamp(l.t, withTime, l.year);
      svg.appendChild(tx);
    });

    // bars: views gained per tracked day, spanning the stretch each one covers
    var baseOpacity = 0.38;
    var bars = daily.map(function (d) {
      if (!d.gained) return null;
      var xa = Math.max(ml + estW, x(d.from)), xb = x(d.to);
      var w = Math.max(3, xb - xa - 2);
      var bx = xb - xa - 2 >= 3 ? xa + 1 : Math.min(W - mr - w, Math.max(ml + estW, xb - w / 2));
      var h = Math.max(1.5, d.gained * gScale);
      var r = svgEl("rect", { x: bx, y: zeroY - h, width: w, height: h, rx: 2, fill: color, opacity: baseOpacity });
      svg.appendChild(r);
      return r;
    });

    if (est) {
      var tx0 = x(tFirst);
      svg.appendChild(svgEl("line", { x1: tx0, x2: tx0, y1: mt, y2: mt + ih, stroke: "#8e8e93",
        "stroke-width": 1, "stroke-dasharray": "2 4", opacity: 0.5 }));
      svg.appendChild(svgEl("path", { d: "M " + x(est.t0).toFixed(2) + " " + y(0).toFixed(2) + " L " +
        tx0.toFixed(2) + " " + y(est.v1).toFixed(2), fill: "none", stroke: color, "stroke-width": 2,
        "stroke-dasharray": "6 5", "stroke-linecap": "round", opacity: 0.55 }));
      if (broken) {
        var bx0 = ml + estW;
        svg.appendChild(svgEl("path", { d: "M " + (bx0 - 6) + " " + (zeroY + 5) + " L " + (bx0 - 1) + " " + (zeroY - 5) +
          " M " + (bx0 + 1) + " " + (zeroY + 5) + " L " + (bx0 + 6) + " " + (zeroY - 5),
          stroke: "#8e8e93", "stroke-width": 1.5, fill: "none" }));
      }
    }
    if (pts.length > 1) {
      var d = "";
      pts.forEach(function (p, i) { d += (i ? " L " : "M ") + x(p.t).toFixed(2) + " " + y(p.v).toFixed(2); });
      svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    var last = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: x(last.t), cy: y(last.v), r: 3, fill: color }));

    // crosshair + tooltip; the estimated stretch says so
    var cross = svgEl("line", { y1: mt, y2: mt + ih, class: "gridline", opacity: 0 });
    cross.style.stroke = "#8e8e93";
    svg.appendChild(cross);
    var dot = svgEl("circle", { r: 4.5, fill: color, stroke: "#1c1c1e", "stroke-width": 2, opacity: 0 });
    svg.appendChild(dot);
    var hit = svgEl("rect", { x: ml, y: mt, width: iw, height: ih, fill: "transparent" });
    svg.appendChild(hit);
    var lit = null;
    var light = function (b) {
      if (lit === b) return;
      if (lit) lit.setAttribute("opacity", baseOpacity);
      if (b) b.setAttribute("opacity", 0.9);
      lit = b;
    };
    hit.addEventListener("mousemove", function (ev) {
      var box = svg.getBoundingClientRect();
      var px = ((ev.clientX - box.left) / box.width) * W;
      var cx, cy, html;
      if (est && px < x(tFirst) - 6) {
        var tt = est.t0 + (Math.max(0, px - ml) / Math.max(1, estW)) * (tFirst - est.t0);
        var ev0 = est.v1 * (tt - est.t0) / Math.max(1, tFirst - est.t0);
        cx = x(tt); cy = y(ev0);
        light(null);
        html = '<div class="tip-title">' + esc(stamp(tt, false, true)) + " \u00b7 estimated</div>" +
          tipRow(color, "Views (estimated)", full(ev0)) +
          tipRow(null, "Basis", "straight line, 0 at posting");
      } else {
        var best = 0;
        pts.forEach(function (p, i) { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px)) best = i; });
        var p = pts[best];
        var di = -1;
        daily.forEach(function (dd, i) { if (di < 0 && p.t >= dd.from && p.t <= dd.to) di = i; });
        var day = di >= 0 ? daily[di] : null;
        cx = x(p.t); cy = y(p.v);
        light(di >= 0 ? bars[di] : null);
        html = '<div class="tip-title">' + esc(stamp(p.t, true)) + "</div>" +
          tipRow(color, "Views", full(p.v)) +
          (day ? tipRow(null, "Gained " + shortDate(day.date) + (day.partial ? " (part day)" : ""), signed(day.gained)) : "");
      }
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("opacity", 0.45);
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("opacity", 1);
      showTip(html, ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", function () {
      cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); light(null); hideTip();
    });

    host.appendChild(svg);
  }

  // ---------------------------------------------------------------- post details
  // A compact strip at the top of each row's drop-down, from /api/details,
  // which the details background function fills every 6 hours. The table
  // itself never gains a column. A missing value says why in its tooltip.
  var WHY = {
    instagram: {
      unsupported: "Instagram doesn't provide this for this post",
      pending: "Instagram hasn't computed this yet for a new post; updates every 6 hours",
      failed: "The last fetch failed; retried every 6 hours",
      none: "Instagram reported nothing for this post",
      notFetched: "Not fetched yet, updates every 6 hours"
    },
    youtube: {
      unsupported: "YouTube doesn't provide this for this video",
      pending: "YouTube analytics lag 2\u20133 days; not reported yet",
      failed: "The last fetch failed; retried every 6 hours",
      none: "YouTube reported no views for this video",
      notFetched: "Not fetched yet, updates every 6 hours"
    }
  };

  function whyMissing(platform, rec, field, problem) {
    if (problem === "loading") return "Loading";
    if (problem) return "Could not load details: " + problem;
    var w = WHY[platform];
    if (!rec) return w.notFetched;
    var reason = rec.missing && rec.missing[field];
    if (reason && w[reason]) return w[reason];
    return rec.error ? w.failed : w.notFetched;
  }

  function statHtml(item) {
    var label = '<span class="xp-stat-label">' + esc(item.label) + "</span>";
    if (item.value === null || item.value === undefined) {
      var loading = item.why === "Loading";
      return '<div class="xp-stat">' + label + '<span class="xp-stat-value is-missing' + (loading ? " is-loading" : "") +
        '" title="' + esc(item.why) + '"' + (loading ? "" : ' tabindex="0" aria-label="' + esc(item.label + ": not available. " + item.why) + '"') +
        ">" + (loading ? "\u2026" : "\u2014") + "</span></div>";
    }
    return '<div class="xp-stat"' + (item.title ? ' title="' + esc(item.title) + '"' : "") + ">" + label +
      '<span class="xp-stat-value">' + esc(item.value) +
      (item.sub ? ' <span class="xp-stat-sub">' + esc(item.sub) + "</span>" : "") + "</span></div>";
  }

  function igStats(row, rec, problem) {
    var val = function (field, label) {
      var v = rec ? rec[field] : null;
      return v === null || v === undefined
        ? { label: label, value: null, why: whyMissing("instagram", rec, field, problem) }
        : { label: label, value: full(v) };
    };
    // Instagram gives follows and profile visits for feed posts only, never reels.
    if (String(row.format || "").toLowerCase() === "reels") return [val("reposts", "Reposts")];
    return [val("follows", "Follows gained"), val("profileVisits", "Profile visits"), val("reposts", "Reposts")];
  }

  function ytStats(row, rec, problem) {
    var out = [];
    var ev = rec ? rec.engagedViews : null;
    out.push(ev === null || ev === undefined
      ? { label: "Engaged views", value: null, why: whyMissing("youtube", rec, "engagedViews", problem) }
      : { label: "Engaged views", value: full(ev),
          sub: rec.analyticsViews > 0 ? pct((ev / rec.analyticsViews) * 100, 0) + " of views" : null });
    var sub = rec ? rec.subscribedViews : null;
    var tot = rec ? (rec.subscribedViews || 0) + (rec.unsubscribedViews || 0) : 0;
    out.push(sub === null || sub === undefined || tot <= 0
      ? { label: "Views from non-subscribers", value: null, why: whyMissing("youtube", rec, "subscribedSplit", problem) }
      : { label: "Views from non-subscribers", value: pct((rec.unsubscribedViews / tot) * 100, 0), sub: compact(rec.unsubscribedViews) });
    var ret = state.retention ? state.retention[row.id] : null;
    var rel = ret ? ret.relativeAvg : null;
    out.push(rel === null || rel === undefined
      ? { label: "Retention vs similar videos", value: null,
          why: row.analyticsPending ? WHY.youtube.pending : "Retention is fetched for the 12 most viewed public videos with at least 100 views" }
      : { label: "Retention vs similar videos", value: rel > 0.5 ? "Above typical" : rel < 0.5 ? "Below typical" : "Typical",
          sub: rel.toFixed(2),
          title: "YouTube's relative retention averaged over the video: 0.50 is typical for videos of similar length, 1.00 the best" });
    out.push(row.followsGained === null || row.followsGained === undefined
      ? { label: "Subscribers gained", value: null, why: row.analyticsPending ? WHY.youtube.pending : "YouTube reported none for this video" }
      : { label: "Subscribers gained", value: full(row.followsGained) });
    return out;
  }

  function drawStats(host, row, resp, problem) {
    var rec = resp ? resp.details : null;
    var items = row.platform === "instagram" ? igStats(row, rec, problem) : ytStats(row, rec, problem);
    var meta;
    if (problem === "loading") meta = "Loading post details";
    else if (problem) meta = "Could not load post details: " + problem;
    else if (!rec) meta = "Post details not fetched yet: they update every 6 hours.";
    else {
      // Measured from the run that fetched it, not the clock, like hook strength.
      var posted = Date.parse(row.publishedAt || row.date);
      var ran = Date.parse(resp.generatedAt);
      var old = isFinite(posted) && (isFinite(ran) ? ran : Date.now()) - posted > ((resp.freshDays || 30) * 86400000);
      meta = (rec.fetchedAt ? "Details updated " + stamp(rec.fetchedAt, true) : "Details not fetched successfully yet") +
        (rec.error ? "; the latest fetch failed, so these are from before" : "") +
        ". Every 6 hours" + (old ? "; posts older than " + (resp.freshDays || 30) + " days keep their last values" : "") + ".";
    }
    host.innerHTML = items.map(statHtml).join("") + '<p class="xp-stat-meta">' + esc(meta) + "</p>";
  }

  function loadStats(host, row) {
    drawStats(host, row, null, "loading");
    getJSON("details:" + postKey(row), "/api/details?platform=" + encodeURIComponent(row.platform) +
      "&id=" + encodeURIComponent(row.id))
      .then(function (resp) { if (host.isConnected) drawStats(host, row, resp); })
      .catch(function (err) { if (host.isConnected) drawStats(host, row, null, err.message); });
  }

  // A post's drop-down: its details strip, views over time, and for a YouTube
  // video with a retention report, its audience retention curve beside it.
  function renderPostPanel(row, panel) {
    var ret = row.platform === "youtube" && state.retention ? state.retention[row.id] : null;
    panel.innerHTML = '<div class="xp-stats"></div>' +
      '<div class="xp-cols' + (ret ? " has-ret" : "") + '">' +
      '<div class="xp-col xp-views"><div class="xp-head"><span class="xp-title">Views over time</span>' +
      '<span class="legend xp-legend"></span></div><div class="xp-chart"></div><p class="xp-note"></p></div>' +
      (ret
        ? '<div class="xp-col xp-ret"><div class="xp-head"><span class="xp-title">Audience retention</span>' +
          '<span class="legend">' + legendItem("line", SERIES.youtube.color, "Still watching") +
          legendItem("dash", "#8e8e93", "100%") + '</span></div><div class="xp-chart"></div>' +
          '<p class="xp-note">The share of viewers still watching at each point through the video, against ' +
          "elapsed position. Above 100% means that moment was replayed. From YouTube's audience " +
          "retention report.</p></div>"
        : "") + "</div>";
    loadStats($(".xp-stats", panel), row);
    if (ret) renderRetention($(".xp-ret .xp-chart", panel), ret);
    var col = $(".xp-views", panel);
    var chart = $(".xp-chart", col);
    emptyState(chart, "Loading");
    getJSON("series:" + postKey(row), "/api/snapshots?platform=" + encodeURIComponent(row.platform) +
      "&id=" + encodeURIComponent(row.id))
      .then(function (series) { if (col.isConnected) drawPostSeries(col, row, series); })
      .catch(function (err) { if (col.isConnected) emptyState(chart, "Could not load: " + err.message); });
  }

  function drawPostSeries(panel, row, series) {
    var color = (SERIES[row.platform] || SERIES.combined).color;
    var chart = $(".xp-chart", panel), note = $(".xp-note", panel);
    var pts = series.points || [];
    var since = (state.data.snapshots && state.data.snapshots.since) || series.since;
    if (!pts.length) {
      emptyState(chart, "Not tracked yet");
      note.textContent = "No snapshot has recorded this post's views yet" +
        (since ? " (tracking since " + stamp(since) + ")" : "") + ". It is picked up on the next refresh.";
      return;
    }
    var est = series.estimate;
    var first = pts[0], last = pts[pts.length - 1];
    if (pts.length === 1 && !est) {
      chart.innerHTML = '<div class="xp-big">' + esc(full(last.views)) + " <span>views</span></div>";
      note.textContent = "One snapshot so far, " + stamp(last.t, true) +
        (series.trackedFromPosting ? ", posted " + stamp(series.publishedAt, true) : "") +
        ". The curve starts with the next refresh.";
      return;
    }
    $(".xp-legend", panel).innerHTML = legendItem("line", color, "Views") +
      (est ? legendItem("dash", color, "Estimated") : "") + legendItem("bar", color, "Gained per day");
    renderViewCurve(chart, series, color);
    var parts = [];
    if (est) {
      parts.push("Before tracking: estimated straight line from 0 at posting to " + full(est.to.views) +
        " on " + stamp(est.to.t) + ". Daily bars cover tracked days only.");
    } else if (series.trackedFromPosting) {
      parts.push("Tracked from posting, " + stamp(series.publishedAt, true) + ".");
    } else {
      parts.push("Tracking began " + stamp(first.t) + " at " + full(first.views) +
        " views. Earlier history cannot be backfilled.");
    }
    parts.push("Latest: " + full(last.views) + " views at " + stamp(last.t, true) + ".");
    note.textContent = parts.join(" ");
  }

  // "Combined by day" rows: that day's views gained across both platforms.
  function renderDayPanel(row, panel) {
    panel.innerHTML = '<div class="xp-chart"></div>';
    var host = panel.firstChild;
    emptyState(host, "Loading");
    getJSON("day:" + row.date, "/api/snapshots?day=" + encodeURIComponent(row.date))
      .then(function (d) { if (panel.isConnected) drawDay(panel, d); })
      .catch(function (err) { if (panel.isConnected) emptyState(host, "Could not load: " + err.message); });
  }

  function drawDay(panel, d) {
    var label = shortDate(d.day);
    var tz = String(d.tz || "").replace(/_/g, " ");
    if (!d.tracked || d.empty) {
      panel.innerHTML = '<div class="empty">' + (d.tracked ? "No snapshot that day" : "Not tracked yet") + "</div>" +
        '<p class="xp-note">' + esc(d.tracked
          ? "No refresh recorded views on " + label + ", so its gains are folded into the next day."
          : "View snapshots began " + (d.since ? stamp(d.since) : "after this day") +
            ". Views gained on " + label + " cannot be split per video.") + "</p>";
      return;
    }
    var bp = d.byPlatform || {};
    var html = '<div class="xp-head"><span class="xp-title">Views gained on ' + esc(label) + "</span>" +
      '<span class="xp-total">' + esc(signed(d.totalGained)) + "</span></div>";
    html += '<div class="xp-split">' + ["instagram", "youtube"].map(function (p) {
      var g = bp[p] ? bp[p].totalGained : 0;
      return '<div class="xp-split-row"><span class="tag"><span class="tag-dot" style="background:' +
        SERIES[p].color + '"></span>' + SERIES[p].label + '</span><span class="gain-num">' + esc(signed(g)) +
        "</span>" + shareHtml(d.totalGained > 0 ? (g / d.totalGained) * 100 : null, SERIES[p].color) + "</div>";
    }).join("") + "</div>";
    var rows = (d.rows || []).filter(function (r) { return r.gained > 0; }).slice(0, 5);
    html += rows.length
      ? '<div class="xp-sub">Top videos that day</div>' + gainTableHtml(rows, d.totalGained)
      : '<div class="empty">No views gained that day</div>';
    var notes = [d.partial
      ? "Partial day: measured from the first snapshot, " + stamp(d.from, true) + "."
      : "Measured from " + stamp(d.from, true) + " to " + stamp(d.to, true) + "."];
    if (!d.complete) notes.push("The day is not over yet.");
    if (d.unknown) {
      notes.push(d.unknown + (d.unknown === 1 ? " older post has" : " older posts have") +
        " no earlier snapshot and " + (d.unknown === 1 ? "is" : "are") + " left out.");
    }
    if (d.revised) notes.push(d.revised + (d.revised === 1 ? " count was" : " counts were") + " revised down and count as no gain.");
    notes.push("Days run midnight to midnight, " + tz + " time.");
    html += '<p class="xp-note">' + esc(notes.join(" ")) + "</p>";
    panel.innerHTML = html;
  }

  // ---------------------------------------------------------------- render
  // Derived once per load: follower history with per-day net change, and the
  // lookups the growth tooltip and the drop-downs read.
  function prepare() {
    var d = state.data;

    // Follower history. Measured snapshots where this dashboard has taken them,
    // reconstructed from per-day follower changes for everything before that.
    var snaps = {};
    (d.history || []).forEach(function (h) {
      snaps[h.date] = { youtube: h.ytFollowers, instagram: h.igFollowers };
    });
    // Instagram's own follows and unfollows, where the details function has
    // fetched them: a true daily net. On those days the level comes from the
    // reconstruction, which walks back through exactly these nets from today's
    // measured total, so bar and line agree with the follows and unfollows.
    state.igNet = {};
    (d.daily || []).forEach(function (p) {
      if (p.igFollows !== null && p.igFollows !== undefined && p.igUnfollows !== null && p.igUnfollows !== undefined) {
        state.igNet[p.date] = { follows: p.igFollows, unfollows: p.igUnfollows };
      }
    });
    var hist = (d.derivedHistory || []).map(function (h) {
      var s = snaps[h.date];
      var igReal = !!state.igNet[h.date] && h.instagram !== null && h.instagram !== undefined;
      return {
        date: h.date,
        youtube: s ? s.youtube : h.youtube,
        instagram: igReal ? h.instagram : s ? s.instagram : h.instagram,
        igReal: igReal
      };
    });
    // Any snapshot dates the reconstruction does not cover.
    Object.keys(snaps).forEach(function (date) {
      if (!hist.some(function (h) { return h.date === date; })) {
        hist.push({ date: date, youtube: snaps[date].youtube, instagram: snaps[date].instagram });
      }
    });
    hist.sort(function (a, b) { return a.date.localeCompare(b.date); });

    // Per-day net change, taken as the difference between consecutive levels so
    // bars and line always agree. Days from the first measured snapshot onward
    // are true nets for both platforms; earlier days inherit the source's
    // fidelity (YouTube true net, Instagram gross adds).
    hist.forEach(function (h, i) {
      h.measured = { youtube: !!snaps[h.date], instagram: !!snaps[h.date] || !!h.igReal };
      var prev = hist[i - 1];
      var ig = state.igNet[h.date];
      h.net = {
        youtube: prev && prev.youtube !== null && h.youtube !== null ? h.youtube - prev.youtube : null,
        instagram: h.igReal ? ig.follows - ig.unfollows
          : prev && prev.instagram !== null && h.instagram !== null ? h.instagram - prev.instagram : null
      };
    });
    state.histAll = hist;

    state.subsByDate = {};
    (d.youtube.subsDaily || []).forEach(function (s) { state.subsByDate[s.date] = s; });
    state.igAddsByDate = {};
    (d.daily || []).forEach(function (p) {
      if (p.igNewFollowers !== null && p.igNewFollowers !== undefined) state.igAddsByDate[p.date] = p.igNewFollowers;
    });
    // Retention is per video, so it rides in that video's drop-down.
    state.retention = {};
    (d.youtube.retention || []).forEach(function (r) { state.retention[r.video] = r; });
  }

  // Only the visible tab is drawn: charts take their host's width, which a
  // hidden panel does not have. Switching tabs draws the new one.
  function render() {
    if (!state.data) return;
    if (state.tab === "overview") renderOverview();
    else if (state.tab === "content") renderContent();
    else if (state.tab === "audience") renderAudience();
  }

  // ---- overview: everything follows the platform switch
  function overviewTiles(d, platform) {
    if (platform === "youtube") {
      var yt = d.youtube;
      return [
        { value: compact(yt.followers), cap: "Subscribers" },
        { value: compact(yt.lifetimeViews), cap: "Lifetime views" },
        { value: String(yt.videos.length), cap: "Videos tracked", sub: yt.posts + " public on channel" },
        { value: compact(yt.engagement), cap: "Engagement" }
      ];
    }
    if (platform === "instagram") {
      var ig = d.instagram;
      return [
        { value: compact(ig.followers), cap: "Followers", sub: "Following " + full(ig.following) },
        { value: compact(ig.lifetimeViews), cap: "Views tracked" },
        { value: String(ig.media.length), cap: "Posts tracked", sub: ig.posts + " on profile" },
        { value: compact(ig.engagement), cap: "Engagement" }
      ];
    }
    return [
      { value: compact(d.totals.followers), cap: "Total audience", sub: compact(d.youtube.followers) + " YouTube · " + compact(d.instagram.followers) + " Instagram" },
      { value: compact(d.totals.views), cap: "Views tracked", sub: "Across " + d.content.length + " pieces of content" },
      { value: compact(d.totals.engagement), cap: "Total engagement", sub: "Likes, comments, shares, saves" },
      { value: String(d.content.length), cap: "Content tracked", sub: d.youtube.videos.length + " videos · " + d.instagram.media.length + " posts" }
    ];
  }

  // Views from people who do not follow (or subscribe), as a share of the views
  // with a split, over the header range.
  function nonFollowerTile(platform) {
    var one = platform === "combined" ? null : platform;
    var f = 0, o = 0, days = 0;
    state.data.daily.slice(-state.range).forEach(function (p) {
      var s = splitOf(p, one);
      if (!s) return;
      f += s.followers; o += s.others; days++;
    });
    var total = f + o;
    return {
      value: total > 0 ? pct((o / total) * 100, 0) : "\u2014",
      cap: one === "youtube" ? "From non-subscribers" : "From non-followers",
      sub: total > 0
        ? compact(o) + " of " + compact(total) + " views, last " + state.range + " days" +
          (days < Math.min(state.range, state.data.daily.length) ? " (" + days + " with a split)" : "")
        : "No follower split yet: fetched every 6 hours"
    };
  }

  function renderOverview() {
    renderTiles($("#ovTiles"), overviewTiles(state.data, state.platform).concat([nonFollowerTile(state.platform)]));
    renderDaily();
    renderGained();
    renderGrowth();
  }

  // ---- content: hook strength over the table
  function renderContent() {
    renderHook();
    renderContentTable();
  }

  // ---- audience: who is watching, both platforms in one grid
  function renderAudience() {
    var yt = state.data.youtube, ig = state.data.instagram;
    renderBars($("#igGeo"), ig.geo, { color: SERIES.instagram.color, metricLabel: "Followers" });
    renderBars($("#igAge"), ig.age, { color: SERIES.instagram.color, metricLabel: "Followers" });
    // Counts upstream; shown as shares so it reads like YouTube's gender card.
    var gTotal = (ig.gender || []).reduce(function (a, r) { return a + r.value; }, 0);
    var G = { M: "male", F: "female", U: "unknown" };
    renderBars($("#igGender"), gTotal > 0 ? ig.gender.map(function (r) {
      return { label: G[String(r.label).toUpperCase()] || String(r.label).toLowerCase(), value: (r.value / gTotal) * 100 };
    }) : [], { color: SERIES.instagram.color, metricLabel: "Share of followers", format: function (v) { return pct(v); } });

    var span = "Last " + state.range + " days, from the header";
    // Traffic carries its date, so it re-aggregates to any window client-side.
    var cutoff = rangeCutoff();
    var trafficTotals = {};
    (yt.trafficDaily || []).forEach(function (r) {
      if (cutoff && r.date < cutoff) return;
      trafficTotals[r.label] = (trafficTotals[r.label] || 0) + r.value;
    });
    renderBars($("#ytTraffic"), Object.keys(trafficTotals)
      .map(function (k) { return { label: k.replace(/_/g, " ").toLowerCase(), value: trafficTotals[k] }; })
      .sort(function (a, b) { return b.value - a.value; }),
      { color: SERIES.youtube.color, metricLabel: "Views" });
    $("#ytTrafficSpan").textContent = span;

    // Country cannot be grouped by date upstream, so each window is its own pull.
    var geo = (yt.geoByWindow && yt.geoByWindow[state.range]) || [];
    renderBars($("#ytGeo"), geo, { color: SERIES.youtube.color, metricLabel: "Views" });
    $("#ytGeoSpan").textContent = span;
    renderBars($("#ytAge"), yt.age.map(function (r) {
      return { label: String(r.label).replace("age", ""), value: r.value };
    }), { color: SERIES.youtube.color, metricLabel: "Share", format: function (v) { return pct(v); } });
    renderBars($("#ytGender"), yt.gender, {
      color: SERIES.youtube.color, metricLabel: "Share", format: function (v) { return pct(v); }
    });
  }

  function renderMeta() {
    var d = state.data;
    var when = new Date(d.generatedAt);
    $("#updated").textContent = "Updated " + when.toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    var warn = (d.warnings && d.warnings.length) ? " · " + d.warnings.length + " partial" : "";
    $("#footMeta").textContent = "PULL " + (d.durationMs || 0) + "MS" + warn.toUpperCase();

    // Say which platforms the numbers came from, so a platform that is not
    // connected yet reads as that rather than as a quiet account.
    var src = d.sources || {};
    var conn = function (name, s) { return name + (s === "direct" ? " API" : s === "off" ? " NOT CONNECTED" : " ?"); };
    var label = "DATA: " + conn("YOUTUBE", src.youtube) + " · " + conn("INSTAGRAM", src.instagram);
    $("#footSource").textContent = label;
    if (d.tokenStatus && d.tokenStatus.daysLeft !== null && d.tokenStatus.daysLeft !== undefined) {
      $("#footSource").textContent = label + " · META TOKEN " + d.tokenStatus.daysLeft + "D LEFT";
    }
  }


  // Follower growth card has its own window (7 / 14 / 30 / custom) independent
  // of the global range chips, because growth is read on a shorter horizon than
  // views and a custom span is the natural way to inspect one campaign.
  function growthWindow(hist) {
    var g = state.growth;
    if (!hist.length) return [];
    if (g.preset === "custom") {
      var from = g.from || hist[0].date, to = g.to || hist[hist.length - 1].date;
      if (from > to) { var t = from; from = to; to = t; }
      return hist.filter(function (h) { return h.date >= from && h.date <= to; });
    }
    return hist.slice(-Number(g.preset));
  }

  function renderGrowth() {
    var d = state.data;
    var hist = state.histAll || [];
    var firstSnapshot = (d.history || []).length ? d.history[0].date : null;
    var win = growthWindow(hist);
    var note = $("#histNote");
    var span = $("#growthSpan");
    if (span) {
      span.textContent = win.length
        ? shortDate(win[0].date) + " – " + shortDate(win[win.length - 1].date) + " · " + win.length + " days"
        : "";
    }
    if (hist.length < 2) {
      emptyState($("#ovHistory"), "Building history");
      note.textContent =
        "Neither platform reports historical follower counts through its API, so this chart is " +
        "built from snapshots taken on each refresh. It fills in from the first refresh onward.";
      return;
    }
    var keys = state.platform === "combined" ? ["youtube", "instagram"] : [state.platform];
    renderGrowthPanels($("#ovHistory"), win, keys);
    var has = function (k) { return keys.indexOf(k) >= 0; };
    var parts = [(keys.length === 1 && has("youtube")
      ? "Bars are the net subscriber change per day (right axis), the line is the subscriber count (left axis)."
      : "Bars are the net follower change per day (right axis), the line is the follower count (left axis).") +
      " Everything before " + (firstSnapshot ? shortDate(firstSnapshot) : "today") +
      " is reconstructed by walking today's total backwards through daily follower changes; " +
      "from then on these are measured snapshots."];
    if (has("youtube")) {
      parts.push("YouTube reports both gains and losses, so its bars are a true net; hover a day for " +
        "the subscribers gained and lost.");
    }
    if (has("instagram")) {
      var netDays = Object.keys(state.igNet || {}).sort();
      parts.push(netDays.length
        ? "Instagram's own follows and unfollows give a true daily net from " + shortDate(netDays[0]) +
          " (fetched every 6 hours); hover a day for both. Before that, Instagram reported only new followers, " +
          "so those bars are gross adds and the earlier levels read low."
        : "Instagram reports only new followers and never unfollows, so before snapshots began its " +
          "bars are gross adds and its earlier levels read low; on measured days the tooltip also gives " +
          "the new followers Instagram reported. Its follows and unfollows arrive with the next 6-hourly details run.");
    }
    if (keys.length > 1) parts.push("Each platform is on its own scale.");
    note.textContent = parts.join(" ");
  }

  // The oldest date the current range includes, derived from the daily series
  // rather than the clock so it lines up with what the data actually covers.
  function rangeCutoff() {
    var d = state.data && state.data.daily;
    if (!d || !d.length) return null;
    var win = d.slice(-state.range);
    return win.length ? win[0].date : null;
  }

  // Views split by who watched. Instagram's UNKNOWN follow type counts as
  // non-followers; YouTube splits on subscribed status. Combined adds both
  // platforms where each has reported.
  function igSplit(p) {
    if (p.igViewsFollower === null || p.igViewsFollower === undefined) return null;
    return { followers: p.igViewsFollower, others: (p.igViewsNonFollower || 0) + (p.igViewsUnknown || 0) };
  }
  function ytSplit(p) {
    if (p.ytViewsSubscribed === null || p.ytViewsSubscribed === undefined) return null;
    return { followers: p.ytViewsSubscribed, others: p.ytViewsUnsubscribed || 0 };
  }
  function splitOf(p, one) {
    if (one === "instagram") return igSplit(p);
    if (one === "youtube") return ytSplit(p);
    var a = igSplit(p), b = ytSplit(p);
    if (!a && !b) return null;
    return {
      followers: (a ? a.followers : 0) + (b ? b.followers : 0),
      others: (a ? a.others : 0) + (b ? b.others : 0)
    };
  }

  function renderFollowerSplit(pts, one) {
    var labels = one === "youtube" ? ["From subscribers", "From non-subscribers"]
      : one === "instagram" ? ["From followers", "From non-followers"]
      : ["From followers and subscribers", "From everyone else"];
    SERIES.followers.label = labels[0];
    SERIES.nonFollowers.label = labels[1];
    var rows = pts.map(function (p) {
      var s = splitOf(p, one);
      return { date: p.date, followers: s ? s.followers : null, nonFollowers: s ? s.others : null };
    });
    var host = $("#ovDaily");
    if (rows.filter(function (r) { return r.followers !== null; }).length < 2) {
      emptyState(host, "No follower split yet: fetched every 6 hours");
      $("#ovLegend").innerHTML = "";
    } else {
      renderLine(host, rows, ["followers", "nonFollowers"]);
      renderLegend($("#ovLegend"), ["followers", "nonFollowers"]);
    }
    renderSplitNote(pts, one);
  }

  function renderSplitNote(pts, one) {
    var lastOf = function (fn) {
      for (var i = pts.length - 1; i >= 0; i--) if (fn(pts[i])) return pts[i].date;
      return null;
    };
    var igLast = one === "youtube" ? null : lastOf(igSplit);
    var ytLast = one === "instagram" ? null : lastOf(ytSplit);
    var plural = function (n) { return n + " day" + (n === 1 ? "" : "s"); };
    var parts = [];
    if (one !== "youtube") {
      parts.push(igLast
        ? "Instagram's split reported through " + shortDate(igLast) + "."
        : "Instagram's follower split has not been fetched yet.");
    }
    if (one !== "instagram") {
      parts.push(!ytLast ? "YouTube has not reported views by subscribed status yet."
        : one ? "YouTube's split reported through " + shortDate(ytLast) +
          "; its analytics settle two to three days behind, so the line stops short of today."
        : "YouTube's through " + shortDate(ytLast) + ".");
    }
    var days = igLast && ytLast ? Math.round(
      (new Date(igLast + "T00:00:00Z") - new Date(ytLast + "T00:00:00Z")) / 86400000) : 0;
    if (!one && days > 0) {
      parts.push("YouTube analytics settle two to three days behind, so the last " + plural(days) +
        " of both lines carry Instagram only, and will rise once YouTube reports.");
    }
    if (one !== "youtube") {
      parts.push("Instagram counts viewers it cannot classify (UNKNOWN) as non-followers here. Its split is " +
        "fetched every 6 hours, so the latest day can trail the total views line.");
    }
    if (one !== "instagram") parts.push("YouTube splits views by whether the viewer was subscribed.");
    $("#lagNote").textContent = parts.join(" ");
    $("#lagNote").hidden = false;
  }

  function renderDaily() {
    // 90 days of history against a spike in the last week leaves most of the
    // plot empty, so the window is selectable and defaults to 30 days.
    var pts = state.data.daily.slice(-state.range);
    var one = state.platform === "combined" ? null : state.platform;
    // By platform and Combined only mean something with both platforms on the
    // chart; on one platform the first chip reads Total. The two-definitions
    // caveat applies whenever both platforms are summed or compared.
    var mode = one && state.mode === "combined" ? "split" : state.mode;
    var chips = $("#modeFilters");
    $('[data-mode="combined"]', chips).hidden = !!one;
    $('[data-mode="split"]', chips).textContent = one ? "Total" : "By platform";
    pressChip(chips, "data-mode", mode);
    $("#viewsNote").hidden = !!one;
    if (mode === "followers") {
      renderFollowerSplit(pts, one);
      return;
    }
    if (one) {
      renderLine($("#ovDaily"), pts, [one]);
      renderLegend($("#ovLegend"), [one]);
    } else if (state.mode === "combined") {
      // Same cut goes to both platforms, so the sum is the closest thing to
      // total daily reach. It adds two differently-defined view metrics, which
      // the note under the chart spells out.
      var merged = pts.map(function (p) {
        var has = p.youtube !== null || p.instagram !== null;
        return { date: p.date, combined: has ? (p.youtube || 0) + (p.instagram || 0) : null };
      });
      renderLine($("#ovDaily"), merged, ["combined"]);
      renderLegend($("#ovLegend"), ["combined"]);
    } else {
      renderLine($("#ovDaily"), pts, ["youtube", "instagram"]);
      renderLegend($("#ovLegend"), ["youtube", "instagram"]);
    }
    renderLagNote(pts, one);
  }

  // Each platform's analytics settles on its own delay. YouTube typically runs
  // two to three days behind, so its line stops short of Instagram's and reads
  // as missing data unless the reason is stated.
  function renderLagNote(pts, one) {
    var host = $("#lagNote");
    var lastOf = function (key) {
      for (var i = pts.length - 1; i >= 0; i--) {
        if (pts[i][key] !== null && pts[i][key] !== undefined) return pts[i].date;
      }
      return null;
    };
    var ytLast = lastOf("youtube");
    var igLast = lastOf("instagram");
    var days = ytLast && igLast ? Math.round(
      (new Date(igLast + "T00:00:00Z") - new Date(ytLast + "T00:00:00Z")) / 86400000
    ) : 0;
    var plural = function (n) { return n + " day" + (n === 1 ? "" : "s"); };
    var parts = [];
    if (one === "instagram") {
      if (igLast) parts.push("Instagram reported through " + shortDate(igLast) + ".");
    } else if (one === "youtube") {
      if (ytLast) parts.push("YouTube reported through " + shortDate(ytLast) + ".");
      if (days > 0) {
        parts.push("YouTube analytics settle two to three days behind, so the line stops " + plural(days) +
          " short of Instagram's. That is a reporting delay, not a drop to zero.");
      }
    } else if (ytLast && igLast) {
      parts.push("YouTube reported through " + shortDate(ytLast) + ", Instagram through " + shortDate(igLast) + ".");
      if (days > 0) {
        parts.push("YouTube analytics settle two to three days behind, so its line stops " + plural(days) +
          " short. That is a reporting delay, not a drop to zero.");
        if (state.mode === "combined") {
          parts.push("The last " + plural(days) + " of the combined line therefore carry Instagram only, " +
            "and will rise once YouTube reports.");
        }
      }
    }
    host.textContent = parts.join(" ");
    host.hidden = !parts.length;
  }

  // ---- hook strength card
  // The platform it plots follows the table filter; under All (and Combined
  // by day) the card's own switch picks one.
  function hookKey() {
    var f = state.contentFilter;
    return f === "instagram" || f === "youtube" ? f : state.hook.platform;
  }

  // Posts in the card's range that carry the measure, oldest first, plus counts
  // of the ones skipped.
  function hookRows(key) {
    var d = state.data;
    var cutoff = null;
    if (state.hook.range !== "all") {
      // Measured back from the data's own timestamp, not the clock.
      var end = Date.parse(d.generatedAt);
      if (!isFinite(end)) end = Date.now();
      cutoff = new Date(end - (state.hook.range - 1) * 86400000).toISOString().slice(0, 10);
    }
    var out = { rows: [], pending: 0, notReels: 0 };
    (key === "instagram" ? d.instagram.media : d.youtube.videos).forEach(function (post) {
      if (!post.date || (cutoff && post.date < cutoff)) return;
      var v = HOOK[key].get(post);
      if (v === null) {
        // Skip rate only exists for reels; a carousel or photo never gets one.
        if (key === "instagram" && !/REEL/i.test(post.format || "")) out.notReels++;
        else out.pending++;
        return;
      }
      out.rows.push({ post: post, value: v });
    });
    out.rows.sort(function (a, b) {
      return String(a.post.publishedAt || a.post.date).localeCompare(String(b.post.publishedAt || b.post.date));
    });
    return out;
  }

  function renderHook() {
    var key = hookKey();
    var f = state.contentFilter;
    $("#hookPlatform").hidden = f === "instagram" || f === "youtube";
    pressChip($("#hookPlatform"), "data-platform", key);
    pressChip($("#hookRange"), "data-hook-range", state.hook.range);
    pressChip($("#hookView"), "data-view", state.hook.view);
    $("#hookMetric").innerHTML = '<span class="tag"><span class="tag-dot" style="background:' +
      SERIES[key].color + '"></span>' + SERIES[key].label + "</span> " + esc(HOOK[key].metric);

    var h = hookRows(key);
    var host = $("#hookChart");
    var within = state.hook.range === "all" ? "" : " in the last " + state.hook.range + " days";
    var scatter = state.hook.view === "scatter";
    if (!h.rows.length) {
      emptyState(host, "No " + (key === "instagram" ? "reels" : "videos") + " with this measure posted" + (within || " yet"));
    } else if (scatter) {
      renderHookScatter(host, h.rows, key, jumpToPost);
    } else {
      renderHookBars(host, h.rows, key, jumpToPost);
    }

    var meta = [h.rows.length + (h.rows.length === 1 ? " post" : " posts") + (within ? " posted" + within : "")];
    if (h.pending) meta.push(h.pending + (h.pending === 1 ? " post has" : " posts have") + " no data yet");
    if (h.notReels) meta.push(h.notReels + (h.notReels === 1 ? " post is not a reel" : " posts are not reels"));
    $("#hookMeta").textContent = meta.join(" · ");

    var how = scatter
      ? "Each dot is a post: views across on a log scale, the same measure up, so a strong hook on a small post stands out. "
      : "Bars run oldest to newest by publish date and thin out as posts accumulate; the chart never grows. ";
    $("#hookNote").textContent = (key === "instagram"
      ? "Taller is better. Instagram exposes no retention curve through its API; its skip rate, the share who " +
        "left inside the first three seconds, is the closest stand-in, so this plots 100 minus that. "
      : "Taller is better. Average percentage viewed is YouTube's per-video retention figure; a video's row " +
        "below also carries its full retention curve where YouTube reports one. ") + how +
      "Click a " + (scatter ? "dot" : "bar") + " to open that post's row in the table.";
  }

  // A bar or dot opens its post's row in the table below: the table switches to
  // that platform if the current filter does not list it, then the row opens,
  // scrolls into view and takes keyboard focus.
  function jumpToPost(post) {
    var f = state.contentFilter;
    if (f !== "all" && f !== post.platform) setContentFilter(post.platform);
    var tableId = contentTableId(), key = postKey(post);
    (state.open[tableId] || (state.open[tableId] = {}))[key] = true;
    renderContentTable();
    var tr = $$("#allTable tr.xp-row").filter(function (r) { return r.getAttribute("data-key") === key; })[0];
    if (!tr) return;
    var btn = $(".xp-toggle", tr);
    if (btn) btn.focus({ preventScroll: true });
    tr.classList.add("is-flash");
    setTimeout(function () { tr.classList.remove("is-flash"); }, 1600);
    tr.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- content table: columns follow the filter
  var CONTENT_VIEWS = {
    all: {
      title: "Everything, both platforms",
      cols: ["platform", "title", "date", "views", "likes", "comments", "engagement", "engRate", "avgWatchSeconds"],
      note: "Columns both platforms report. Pick Instagram for reach, saves, shares and skip rate, or YouTube " +
        "for average view percentage, visibility and subscribers gained. A dash means the platform does not report " +
        "that figure for the post. Click a row for its views over time; the platform button opens the post."
    },
    instagram: {
      title: "Every post",
      cols: ["title", "date", "format", "views", "reach", "likes", "comments", "saves", "shares", "skipRate", "avgWatchSeconds"],
      pill: true,
      note: "Skip rate is the share of viewers who left inside the first three seconds, so lower is better. " +
        "Click a row for that post's reposts (plus follows gained and profile visits on feed posts), " +
        "and its views over time. The Instagram button opens the post."
    },
    youtube: {
      title: "Every video",
      cols: ["title", "date", "format", "privacy", "views", "likes", "comments", "avgViewPercent", "avgWatchSeconds", "followsGained"],
      pill: true,
      note: "Follows are subscribers gained from the video. Click a row for that video's engaged views, views " +
        "from non-subscribers and retention against similar videos, its views over time and, where YouTube " +
        "reports it, its audience retention curve. The YouTube button opens the video."
    }
  };

  function contentTableId() {
    return state.contentFilter === "combined" ? "combined" : "content-" + state.contentFilter;
  }

  function setContentFilter(f) {
    state.contentFilter = f;
    pressChip($("#contentFilters"), "data-filter", f);
    if (state.data) renderContent();
  }

  function renderContentTable() {
    if (state.contentFilter === "combined") {
      $("#contentTitle").textContent = "Releases by day";
      renderTable($("#allTable"), state.data.combined,
        ["combinedTitle", "date", "views", "youtubeViews", "instagramViews", "engagement", "engRate", "saves"],
        "combined", { key: releaseKey, expand: renderDayPanel });
      $("#contentNote").textContent =
        "Pieces posted on the same day are treated as one release, since the same cut goes to " +
        "both platforms. The join key is publish date, not an identifier, so two unrelated posts " +
        "on one day would merge; each row names its pieces so that stays visible. Combined views " +
        "add two differently-defined metrics and are a reach proxy, not a precise count. Click a " +
        "row for the views gained across both platforms on that day.";
      return;
    }
    var view = CONTENT_VIEWS[state.contentFilter];
    var rows = state.data.content;
    if (state.contentFilter !== "all") {
      rows = rows.filter(function (r) { return r.platform === state.contentFilter; });
    }
    $("#contentTitle").textContent = view.title;
    renderTable($("#allTable"), rows, view.cols, contentTableId(),
      { key: postKey, expand: renderPostPanel, pill: !!view.pill });
    $("#contentNote").textContent = view.note;
  }

  // ---------------------------------------------------------------- data
  function apiHeaders() {
    var k = localStorage.getItem(KEY_STORE);
    return k ? { "x-dash-key": k } : {};
  }

  function load() {
    $("#status").hidden = false;
    $("#status").className = "status";
    $("#status").textContent = "Loading data";

    fetch("/api/data", { headers: apiHeaders() })
      .then(function (res) {
        if (res.status === 401) { showGate(); return null; }
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "request failed");
          return body;
        });
      })
      .then(function (data) {
        if (!data) return;
        state.data = data;
        state.posts = null;
        state.cache = {};
        prepare();
        $("#gate").hidden = true;
        $("#status").hidden = true;
        showPanels(true);
        render();
        renderMeta();
      })
      .catch(function (err) {
        showPanels(false);
        $("#status").hidden = false;
        $("#status").className = "status is-error";
        $("#status").textContent =
          "Could not load data: " + err.message +
          ". If this is a fresh deploy, the first scheduled refresh may not have run yet.";
      });
  }

  function showPanels(show) {
    $$(".panel").forEach(function (p) {
      p.hidden = !show || p.getAttribute("data-panel") !== state.tab;
    });
  }

  function showGate() {
    showPanels(false);
    $("#status").hidden = true;
    $("#gate").hidden = false;
  }

  // ---------------------------------------------------------------- events
  $("#gateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("#gateInput").value.trim();
    if (!v) return;
    localStorage.setItem(KEY_STORE, v);
    $("#gateErr").hidden = true;
    fetch("/api/data", { headers: { "x-dash-key": v } }).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem(KEY_STORE);
        $("#gateErr").hidden = false;
        return;
      }
      load();
    });
  });

  var RAIL = { overview: "01 / OVERVIEW", content: "02 / CONTENT", audience: "03 / AUDIENCE", schedule: "04 / SCHEDULE" };
  var TABS = $$(".tab").map(function (t) { return t.getAttribute("data-tab"); });

  function selectTab(name) {
    state.tab = name;
    $$(".tab").forEach(function (t) {
      var on = t.getAttribute("data-tab") === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("#railSection").textContent = RAIL[name] || "";
    showPanels(!!state.data);
    render();
  }

  $("#tabs").addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tab");
    if (!btn) return;
    selectTab(btn.getAttribute("data-tab"));
    store(TAB_STORE, state.tab);
    document.dispatchEvent(new CustomEvent("spd:tab", { detail: state.tab }));
  });

  // One handler shape for every chip group: read the chip's value, mark it
  // active, then hand the value on.
  function onChip(sel, attr, fn) {
    $(sel).addEventListener("click", function (ev) {
      var chip = ev.target.closest(".chip");
      if (!chip) return;
      var v = chip.getAttribute(attr);
      pressChip(this, attr, v);
      fn(v);
    });
  }

  onChip("#platformFilters", "data-platform", function (v) {
    state.platform = v;
    store(PLATFORM_STORE, v);
    if (state.data) renderOverview();
  });

  onChip("#contentFilters", "data-filter", setContentFilter);

  onChip("#hookPlatform", "data-platform", function (v) {
    state.hook.platform = v;
    if (state.data) renderHook();
  });
  onChip("#hookRange", "data-hook-range", function (v) {
    state.hook.range = v === "all" ? "all" : Number(v);
    if (state.data) renderHook();
  });
  onChip("#hookView", "data-view", function (v) {
    state.hook.view = v;
    store(HOOK_VIEW_STORE, v);
    if (state.data) renderHook();
  });

  onChip("#gainFilters", "data-window", function (v) {
    state.gainWindow = v;
    if (state.data) renderGained();
  });

  onChip("#rangeFilters", "data-range", function (v) {
    state.range = Number(v);
    render();
  });

  onChip("#growthFilters", "data-growth", function (v) {
    state.growth.preset = v === "custom" ? "custom" : Number(v);
    var custom = $("#growthCustom");
    custom.hidden = v !== "custom";
    if (v === "custom" && state.histAll && state.histAll.length) {
      var hist = state.histAll;
      var fromEl = $("#growthFrom"), toEl = $("#growthTo");
      fromEl.min = toEl.min = hist[0].date;
      fromEl.max = toEl.max = hist[hist.length - 1].date;
      if (!fromEl.value) fromEl.value = hist[Math.max(0, hist.length - 30)].date;
      if (!toEl.value) toEl.value = hist[hist.length - 1].date;
      state.growth.from = fromEl.value; state.growth.to = toEl.value;
    }
    if (state.data) renderGrowth();
  });
  ["#growthFrom", "#growthTo"].forEach(function (sel) {
    $(sel).addEventListener("change", function () {
      state.growth.from = $("#growthFrom").value || null;
      state.growth.to = $("#growthTo").value || null;
      if (state.data) renderGrowth();
    });
  });

  onChip("#modeFilters", "data-mode", function (v) {
    state.mode = v;
    if (state.data) renderDaily();
  });

  $("#refreshBtn").addEventListener("click", function () {
    var btn = $("#refreshBtn");
    btn.disabled = true;
    btn.textContent = "Refreshing";
    fetch("/api/refresh", { method: "POST", headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body.ok) throw new Error(body.error || "refresh failed");
        load();
      })
      .catch(function (err) {
        $("#status").hidden = false;
        $("#status").className = "status is-error";
        $("#status").textContent = "Refresh failed: " + err.message;
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "Refresh now";
      });
  });

  // Redraw at the new width. Height-only resizes (a phone's address bar
  // showing and hiding while scrolling) change nothing that is drawn.
  var lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    render();
  });

  // Restore the last view. A remembered tab that no longer exists (the old
  // YouTube and Instagram tabs) falls back to the overview.
  state.platform = stored(PLATFORM_STORE, ["combined", "instagram", "youtube"], "combined");
  state.hook.view = stored(HOOK_VIEW_STORE, ["bars", "scatter"], "bars");
  pressChip($("#platformFilters"), "data-platform", state.platform);
  pressChip($("#hookView"), "data-view", state.hook.view);
  selectTab(stored(TAB_STORE, TABS, "overview"));

  load();
})();
