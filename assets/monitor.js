// DSH Mission Control — polls the live snapshot and redraws the visualisation.
(function () {
    'use strict';

    var INIT = window.__MONITOR_INIT__ || {};
    var POLL_MS = 1500;
    var BURST_MS = 5000;      // how long a completed delegation keeps glowing
    var FADE_MS = 45000;      // finished agents dim after this long
    // A finished agent lingers slightly longer than its hand-off burst, so the green
    // return signal always plays out in full before the robot leaves the stage.
    var AUTO_HIDE_MS = 6000;

    var state = {
        data: INIT,
        paused: false,
        follow: window.__MONITOR_FOLLOW__ !== false,   // hop to a newer session
        // 'auto'   — finished agents leave 6s after they go quiet (default)
        // 'shown'  — keep every agent on screen
        // 'hidden' — never draw a finished agent
        finishedMode: 'auto',
        rootId: INIT.rootId || null,                   // detect a session switch
        prev: null,          // {tokens, at}
        burn: 0,             // output tokens per minute (smoothed)
        burnHistory: [],
        seen: {},            // feed keys already rendered
        drawnNodes: {},      // agent ids drawn last render, to fade in only new ones
        slots: {},           // agentId -> sticky ring slot, so agents never shuffle
        orbit: {},           // agentId -> angular motion state (see syncOrbit)
        pairCool: {},        // "idA|idB" -> timestamp before which the pair won't re-reverse
        gfx: null,           // DOM refs cached for the animation loop
        animT: 0,            // seconds of animation, drives the particle phases
        rootAgentId: null,   // so geoOf() knows which id is pinned to the centre
        statuses: {},        // agentId -> last status, for delegation bursts
        finishedAt: {},      // agentId -> when it stopped working
        bursts: {},          // agentId -> timestamp until which to show a burst
        failures: 0
    };

    var $ = function (id) { return document.getElementById(id); };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function num(n) { return Number(n || 0).toLocaleString('en-US'); }

    function compact(n) {
        n = Number(n || 0);
        if (n < 1000) return String(n);
        if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
        return (n / 1e6).toFixed(1) + 'M';
    }

    function dur(ms) {
        if (ms == null || ms < 0) return '—';
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        if (m < 60) return m + 'm ' + (s % 60) + 's';
        return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    function clock(ms) {
        if (!ms) return '—';
        var d = new Date(ms);
        return String(d.getHours()).padStart(2, '0') + ':' +
               String(d.getMinutes()).padStart(2, '0') + ':' +
               String(d.getSeconds()).padStart(2, '0');
    }

    /** Wall-clock duration: running agents grow, finished ones freeze. */
    function agentDur(a, now) {
        if (!a.createdAt) return null;
        var end = (a.status === 'done' && a.modifiedAt) ? a.modifiedAt : now;
        return end - a.createdAt;
    }

    /** Short, stable display name. */
    function shortName(a, isRoot) {
        if (isRoot) return 'main';
        var s = (a.label || a.id).replace(/^(Audit|Review|Analyse|Analyze|Check)\s+/i, '');
        return s.length > 22 ? s.slice(0, 21) + '…' : s;
    }

    var COL = { working: '#ffb454', done: '#37c98b', starting: '#4fa3ff', idle: '#64748b' };
    function statusColor(st) { return COL[st] || COL.idle; }

    /**
     * A little robot, drawn in a unit space roughly x[-1,1] y[-1.6,1.15] and
     * scaled so it fits the node. `size` is the half-height in px.
     * Returns an SVG group; `fill` colours the body (status colour), `ink` the
     * face details.
     */
    function robot(size, fill, ink) {
        var s = size / 1.4;
        // translate() comes after scale() so the 0.22 nudge is in unit space,
        // centring the robot's mass (antenna up top, body below) on the node.
        return '<g transform="scale(' + s.toFixed(2) + ') translate(0 0.22)" fill="' + fill + '">' +
            // antenna
            '<circle cx="0" cy="-1.62" r="0.17"/>' +
            '<rect x="-0.07" y="-1.5" width="0.14" height="0.5" rx="0.06"/>' +
            // ears
            '<rect x="-1.2" y="-0.62" width="0.22" height="0.5" rx="0.1"/>' +
            '<rect x="0.98" y="-0.62" width="0.22" height="0.5" rx="0.1"/>' +
            // head
            '<rect x="-1.0" y="-1.06" width="2.0" height="1.55" rx="0.4"/>' +
            // eyes
            '<circle cx="-0.38" cy="-0.5" r="0.21" fill="' + ink + '"/>' +
            '<circle cx="0.38" cy="-0.5" r="0.21" fill="' + ink + '"/>' +
            // mouth
            '<rect x="-0.42" y="-0.02" width="0.84" height="0.15" rx="0.07" fill="' + ink + '"/>' +
            // body + arms
            '<rect x="-0.62" y="0.6" width="1.24" height="0.58" rx="0.2"/>' +
            '<rect x="-0.92" y="0.66" width="0.24" height="0.44" rx="0.11"/>' +
            '<rect x="0.68" y="0.66" width="0.24" height="0.44" rx="0.11"/>' +
            '</g>';
    }

    // ---------------------------------------------------------------- tiles
    /**
     * Burn-rate history. Always returns an SVG of the SAME size, drawing a flat
     * baseline until there are two samples — otherwise the tile grows ~20px once
     * the second poll lands and the whole metric row jumps.
     */
    var SPARK_W = 96, SPARK_H = 18;

    function sparkline(values, colour) {
        var max = Math.max.apply(null, (values || []).concat([1]));
        var pts = (values && values.length >= 2)
            ? values.map(function (v, i) {
                var x = (i / (values.length - 1)) * SPARK_W;
                var y = SPARK_H - (v / max) * (SPARK_H - 3) - 1.5;
                return x.toFixed(1) + ',' + y.toFixed(1);
            }).join(' ')
            : '0,' + (SPARK_H - 2) + ' ' + SPARK_W + ',' + (SPARK_H - 2);

        return '<svg class="spark" width="' + SPARK_W + '" height="' + SPARK_H + '" ' +
               'viewBox="0 0 ' + SPARK_W + ' ' + SPARK_H + '">' +
               '<polyline points="' + pts + '" fill="none" stroke="' + colour +
               '" stroke-width="1.5" stroke-linejoin="round" opacity="' +
               ((values && values.length >= 2) ? '.85' : '.25') + '"/></svg>';
    }

    function renderTiles(d) {
        var root = d.root, s = d.summary || {};
        var N = {
            violet: '#a77bff', blue: '#4fa3ff', cyan: '#35c9d6', red: '#ff6b6b',
            green: '#37c98b', amber: '#ffb454', indigo: '#7d8bff', pink: '#e879a8'
        };
        var tiles = [
            { k: 'subagents', v: num(s.subagents || 0), a: N.violet,
              s: (s.working || 0) + ' working · ' + (s.done || 0) + ' done' },
            { k: 'turns / steps', v: num(root.turnStarts) + ' / ' + num(root.steps), a: N.blue, s: 'root agent' },
            { k: 'tool calls', v: num(root.toolCalls), a: N.cyan,
              s: Object.keys(root.byTool || {}).length + ' distinct' },
            { k: 'errors', v: num(root.errors), a: root.errors ? N.red : N.green,
              s: root.errors ? 'needs attention' : 'clean' },
            { k: 'tokens out', v: compact(root.tokens && root.tokens.outputTokens), a: N.green,
              s: compact(root.tokens && root.tokens.cacheReadTokens) + ' cached' },
            { k: 'burn rate', v: compact(Math.round(state.burn)), a: N.amber, s: 'tokens / min',
              spark: sparkline(state.burnHistory, N.amber) },
            { k: 'elapsed', v: dur(agentDur(root, d.now)), a: N.indigo, s: 'wall clock' },
            { k: 'last event', v: dur(root.quietMs) + ' ago', a: N.pink,
              s: root.status === 'working' ? 'still running' : 'finished' }
        ];
        $('tiles').innerHTML = tiles.map(function (t) {
            return '<div class="tile" style="--accent:' + t.a + '">' +
                   '<div class="k">' + esc(t.k) + '</div>' +
                   '<div class="v">' + esc(t.v) + '</div>' +
                   '<div class="s">' + esc(t.s) + '</div>' +
                   (t.spark || '') + '</div>';
        }).join('');
    }

    // ---------------------------------------------------------------- graph
    /**
     * Stable ring geometry.
     *
     * Two things had to stop depending on who is on screen, or the whole graph
     * rescaled and rotated every time an agent appeared or was auto-hidden:
     *
     *  1. SLOTS are sticky and assigned client-side. An agent keeps its slot for as
     *     long as it is drawn, so removing a neighbour frees a gap instead of
     *     rotating everyone. New agents take the lowest free slot.
     *  2. CAPACITY is quantised into buckets of SLOT_BUCKET (min SLOT_MIN). Within a
     *     bucket the angular step and radius are constant, so the ring does not
     *     rescale; only every 6th agent crosses a boundary and re-lays out.
     *
     * The viewBox is derived from the capacity (not from where the visible agents
     * happen to be), so it too stays fixed inside a bucket.
     */
    var SLOT_BUCKET = 6;
    var SLOT_MIN = 12;

    // ---- orbit motion
    var CX = 500, CY = 262;                   // stage centre, in user units
    var AVOID_D = 88;                         // reverse this far out, before contact
    var TOUCH_D = 52;                         // robots are ~49px wide: push apart inside this
    var REVERSE_COOL_MS = 700;                // per PAIR, so a third neighbour still counts
    var MAX_PUSH = 0.14;                      // rad/frame cap, so a crush cannot teleport
    var SPEED_MIN = 0.075, SPEED_MAX = 0.24;  // rad/s — a full lap in roughly 26–84s
    var SUB_R_OFF = 54;                       // sub-agent label offset from its centre
    var LABEL_ANCHOR = 0.35;

    function assignSlots(childAgents) {
        var live = {};
        childAgents.forEach(function (a) { live[a.id] = 1; });

        // Forget agents that are no longer drawn, freeing their slots for reuse.
        Object.keys(state.slots).forEach(function (id) {
            if (!live[id]) delete state.slots[id];
        });

        // Newcomers take the lowest free slot, oldest first for determinism.
        childAgents
            .filter(function (a) { return state.slots[a.id] === undefined; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
            .forEach(function (a) {
                var used = {};
                Object.keys(state.slots).forEach(function (id) { used[state.slots[id]] = 1; });
                var i = 0;
                while (used[i]) i++;
                state.slots[a.id] = i;
            });
    }

    /**
     * Van der Corput sequence in [0,1): slot 0,1,2,3… maps to 0.5, 0.25, 0.75,
     * 0.125… so the first few slots spread around the whole circle instead of
     * bunching in one arc. Each slot's angle is permanent, which is the point: the
     * graph looks balanced at any count AND never re-shuffles.
     */
    function spread(i) {
        var f = 0.5, r = 0;
        i = i + 1;
        while (i > 0) {
            r += (i & 1) * f;
            i >>= 1;
            f /= 2;
        }
        return r;
    }

    function layout(d) {
        var cx = CX, cy = CY;
        var pos = {};
        var geom = {};
        pos[d.root.id] = { x: cx, y: cy };

        var byDepth = {};
        (d.agents || []).forEach(function (a) {
            if (a.id === d.root.id) return;
            (byDepth[a.depth] = byDepth[a.depth] || []).push(a);
        });

        Object.keys(byDepth).forEach(function (depth) {
            var list = byDepth[depth];
            var highest = 0;
            list.forEach(function (a) {
                highest = Math.max(highest, (state.slots[a.id] || 0) + 1);
            });
            var capacity = Math.max(SLOT_MIN, Math.ceil(Math.max(1, highest) / SLOT_BUCKET) * SLOT_BUCKET);
            var R = (Number(depth) === 1 ? 17 : 20) * capacity + 40;

            geom[depth] = { capacity: capacity, R: R };
            list.forEach(function (a) {
                var ang = -Math.PI / 2 + 2 * Math.PI * spread(state.slots[a.id] || 0)
                          + Number(depth) * 0.45;
                pos[a.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), ang: ang };
            });
        });

        if (!geom[1]) {
            geom[1] = { capacity: SLOT_MIN, R: 17 * SLOT_MIN + 40 };
        }
        return { pos: pos, geom: geom };
    }

    /**
     * Orbital motion.
     *
     * Every sub-agent rides its depth's ring at its own speed and direction, so the
     * constellation drifts instead of freezing between polls. A position is derived
     * from an angle rather than stored as x/y, which is what makes "reverse when you
     * meet" a change of sign instead of a path rewrite.
     *
     * This state lives in `state`, NOT on the DOM: renderGraph() rebuilds the SVG
     * from a string every poll, so anything hung off an element dies 1.5s later.
     */

    /** The current point of an agent: the root never moves, the rest orbit. */
    function geoOf(id) {
        return id === state.rootAgentId ? { x: CX, y: CY } : state.orbit[id];
    }

    function place(o) {
        o.x = CX + o.ring * Math.cos(o.ang);
        o.y = CY + o.ring * Math.sin(o.ang);
    }

    /** Keep the orbit set in step with what is on screen; newcomers get a speed. */
    function syncOrbit(d, visible, laid) {
        var keep = {};
        visible.forEach(function (a) {
            if (a.id === d.root.id) return;
            keep[a.id] = 1;
            var geom = laid.geom[a.depth] || laid.geom[1];
            var o = state.orbit[a.id];
            if (!o) {
                var seed = laid.pos[a.id];
                var ang = seed ? seed.ang
                    : (-Math.PI / 2 + 2 * Math.PI * spread(state.slots[a.id] || 0));
                o = state.orbit[a.id] = {
                    ang: ang,
                    ring: geom.R,
                    // Random and independent: some clockwise, some not, none in step.
                    vel: (SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN))
                         * (Math.random() < 0.5 ? -1 : 1),
                    x: 0, y: 0, prevX: 0, prevY: 0
                };
                place(o);
                o.prevX = o.x;
                o.prevY = o.y;
            }
            o.ring = geom.R;    // a capacity-bucket change re-lays the ring out
        });
        Object.keys(state.orbit).forEach(function (id) {
            if (!keep[id]) delete state.orbit[id];
        });
    }

    /** A sub-agent's label sits outside the robot, radiating away from main. */
    function labelPoint(id) {
        var o = state.orbit[id];
        var ang = o ? o.ang : -Math.PI / 2;
        var ux = Math.cos(ang), uy = Math.sin(ang);
        return {
            lx: Math.round(ux * SUB_R_OFF),
            ly: Math.round(uy * SUB_R_OFF + 5),
            anchor: ux > LABEL_ANCHOR ? 'start' : (ux < -LABEL_ANCHOR ? 'end' : 'middle')
        };
    }

    function advance(dt) {
        var ids = Object.keys(state.orbit);
        var i, j;
        for (i = 0; i < ids.length; i++) {
            var o = state.orbit[ids[i]];
            o.prevX = o.x;
            o.prevY = o.y;
            o.ang += o.vel * dt;
            place(o);
        }

        // 1. Predictive bounce. An agent closing on a neighbour reverses while there
        //    is still room, so the reflex reads as "turn around", not "clunk".
        //    The cooldown is per PAIR: one reversal must not deafen an agent to the
        //    other neighbours it is about to meet.
        var now = Date.now();
        for (i = 0; i < ids.length; i++) {
            for (j = i + 1; j < ids.length; j++) {
                var a = state.orbit[ids[i]], b = state.orbit[ids[j]];
                var dx = b.x - a.x, dy = b.y - a.y;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= AVOID_D) continue;

                var pdx = b.prevX - a.prevX, pdy = b.prevY - a.prevY;
                if (dist >= Math.sqrt(pdx * pdx + pdy * pdy) - 0.01) continue;   // not closing

                var key = ids[i] < ids[j] ? ids[i] + '|' + ids[j] : ids[j] + '|' + ids[i];
                if ((state.pairCool[key] || 0) > now) continue;
                state.pairCool[key] = now + REVERSE_COOL_MS;

                a.vel = -a.vel;
                b.vel = -b.vel;
            }
        }

        // 2. Hard separation. Reversing alone cannot undo an overlap that already
        //    exists, so any remaining contact is pushed out along each agent's ring
        //    tangent, split by how much of the gap that tangent can actually deliver.
        for (i = 0; i < ids.length; i++) {
            for (j = i + 1; j < ids.length; j++) {
                separate(state.orbit[ids[i]], state.orbit[ids[j]]);
            }
        }
    }

    /** Push two touching agents apart along their own rings. */
    function separate(a, b) {
        var dx = b.x - a.x, dy = b.y - a.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= TOUCH_D) return;
        if (dist < 1e-6) {                  // exactly coincident: shove one sideways
            a.ang -= 0.06;
            place(a);
            return;
        }

        var ux = dx / dist, uy = dy / dist;
        var need = TOUCH_D - dist;

        // Screen-space displacement per radian, projected on the separation axis.
        // Near zero when the pair is aligned radially, where a tangential nudge
        // barely helps — that side then simply does less of the work.
        var pa = a.ring * (-Math.sin(a.ang) * ux + Math.cos(a.ang) * uy);
        var pb = b.ring * (-Math.sin(b.ang) * ux + Math.cos(b.ang) * uy);
        var da = Math.abs(pa) > a.ring * 0.08 ? -(need / 2) / pa : 0;
        var db = Math.abs(pb) > b.ring * 0.08 ? (need / 2) / pb : 0;
        if (!da && !db) { da = -0.05; db = 0.05; }   // degenerate: break the tie

        a.ang += Math.max(-MAX_PUSH, Math.min(MAX_PUSH, da));
        b.ang += Math.max(-MAX_PUSH, Math.min(MAX_PUSH, db));
        place(a);
        place(b);
    }

    /**
     * Write the live geometry onto the elements renderGraph() produced.
     *
     * Edges and signal dots are repositioned too: an edge is a parent→child straight
     * line, so both are a lerp between two moving points. The dots used to be SMIL
     * animateMotion riding a static path, which would have left them sailing down a
     * line the robot had already left.
     */
    function applyGfx() {
        var g = state.gfx;
        if (!g) return;
        var i;

        for (i = 0; i < g.nodes.length; i++) {
            var nd = g.nodes[i];
            if (nd.isRoot || !nd.el) continue;
            var o = state.orbit[nd.id];
            if (!o) continue;
            nd.el.setAttribute('transform',
                'translate(' + o.x.toFixed(1) + ' ' + o.y.toFixed(1) + ')');
            var lp = labelPoint(nd.id);
            if (nd.label) {
                nd.label.setAttribute('x', lp.lx);
                nd.label.setAttribute('y', lp.ly);
                nd.label.setAttribute('text-anchor', lp.anchor);
            }
            if (nd.sub) {
                nd.sub.setAttribute('x', lp.lx);
                nd.sub.setAttribute('y', lp.ly + 15);
                nd.sub.setAttribute('text-anchor', lp.anchor);
            }
        }

        for (i = 0; i < g.edges.length; i++) {
            var e = g.edges[i];
            if (!e.line) continue;
            var ea = geoOf(e.parent), eb = geoOf(e.child);
            if (!ea || !eb) continue;
            e.line.setAttribute('d', 'M' + ea.x.toFixed(1) + ' ' + ea.y.toFixed(1) +
                                     ' L' + eb.x.toFixed(1) + ' ' + eb.y.toFixed(1));
        }

        for (i = 0; i < g.particles.length; i++) {
            var pt = g.particles[i];
            if (!pt.el) continue;
            var pa = geoOf(pt.edge.parent), pb = geoOf(pt.edge.child);
            if (!pa || !pb) continue;
            var t = (pt.phase + state.animT / pt.dur) % 1;
            if (pt.dir < 0) t = 1 - t;          // the hand-off flows back to main
            pt.el.setAttribute('cx', (pa.x + (pb.x - pa.x) * t).toFixed(1));
            pt.el.setAttribute('cy', (pa.y + (pb.y - pa.y) * t).toFixed(1));
        }
    }

    var lastFrameTs = 0;

    function frame(ts) {
        requestAnimationFrame(frame);
        if (!state.gfx || !lastFrameTs) { lastFrameTs = ts; return; }
        var dt = (ts - lastFrameTs) / 1000;
        lastFrameTs = ts;
        if (!(dt > 0)) return;
        if (dt > 0.05) dt = 0.05;   // a backgrounded tab must not teleport anyone
        state.animT += dt;
        advance(dt);
        applyGfx();
    }

    /** Orbiting is decoration, so skip it for anyone who asked for less motion. */
    function motionEnabled() {
        return !(window.matchMedia
                 && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /**
     * The agents to draw. The root is always shown.
     *
     * A *working* agent is never auto-hidden, even when it has gone quiet: an LLM
     * call writes no log events while it runs, so hiding on quiet-time alone would
     * make agents flicker in and out between thinking and calling a tool. Only
     * finished agents are eligible, which is the clutter people actually see.
     *
     * Sub-agents are spawned "continuable" and can be sent another message later;
     * that writes a fresh turn/start, the status flips back to working, and the
     * agent reappears on its own.
     *
     * Shared by the constellation and the roster so the button means one thing.
     */
    function visibleAgents(d) {
        return (d.agents || []).filter(function (a) {
            if (a.id === d.root.id) return true;
            if (a.status !== 'done') return true;              // working / starting
            if (state.finishedMode === 'shown') return true;
            if (state.finishedMode === 'hidden') return false;
            // 'auto': linger briefly after finishing, then leave the stage.
            return a.quietMs != null && a.quietMs <= AUTO_HIDE_MS;
        });
    }

    function renderGraph(d) {
        var all = d.agents || [];
        var visible = visibleAgents(d);
        var hidden = all.length - visible.length;

        // Sticky slots for the agents being drawn, then lay out. Hiding an agent frees
        // its slot rather than re-numbering the rest, so nothing moves.
        assignSlots(visible.filter(function (a) { return a.id !== d.root.id; }));
        var laid = layout({ root: d.root, agents: visible, now: d.now });
        var pos = laid.pos;

        state.rootAgentId = d.root.id;
        syncOrbit(d, visible, laid);

        var agents = {};
        all.forEach(function (a) { agents[a.id] = a; });
        agents[d.root.id] = d.root;

        var shown = {};
        visible.forEach(function (a) { shown[a.id] = 1; });
        shown[d.root.id] = 1;

        var now = d.now;
        var html = '<defs>' +
            '<radialGradient id="halo" cx="50%" cy="50%">' +
              '<stop offset="0%" stop-color="#4fa3ff" stop-opacity=".16"/>' +
              '<stop offset="100%" stop-color="#4fa3ff" stop-opacity="0"/></radialGradient>' +
            '<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">' +
              '<feGaussianBlur stdDeviation="5" result="b"/>' +
              '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
            '</defs>';

        // Fit the viewBox to the ring CAPACITY, not to where the visible agents happen
        // to sit, so the zoom is constant inside a capacity bucket.
        var maxR = 130;
        Object.keys(laid.geom).forEach(function (depth) {
            if (laid.geom[depth].R > maxR) maxR = laid.geom[depth].R;
        });
        // Room for the labels, which sit outside each node and radiate outward. Both
        // the label length and the room are CONSTANT (not derived from the current
        // agent count or the longest label seen), so the frame only ever changes when
        // a capacity bucket is crossed — never when one agent appears or is hidden.
        var maxLen = 20;
        var CHAR_W = 7.8;                              // 13px monospace, in user units
        var labelRoom = 58 + maxLen * CHAR_W + 22;
        var halfW = maxR + labelRoom;
        var vbW = halfW * 2;
        var vbH = Math.max(vbW / 1.38, (maxR + 70) * 2);
        $('graph').setAttribute('viewBox',
            (CX - halfW) + ' ' + (CY - vbH / 2) + ' ' + vbW + ' ' + vbH);

        html += '<circle cx="' + CX + '" cy="' + CY + '" r="' + (maxR + 40) + '" fill="url(#halo)"/>';
        [0.62, 1].forEach(function (f, i) {
            var rr = maxR * f;
            if (rr < 40) return;
            html += '<circle cx="' + CX + '" cy="' + CY + '" r="' + rr.toFixed(0) + '" fill="none" ' +
                    'stroke="rgba(120,150,190,.14)" stroke-width="1" stroke-dasharray="2 9"' +
                    (i ? ' opacity=".6"' : '') + '/>';
        });
        html += '<line x1="' + (CX - halfW) + '" y1="' + CY + '" x2="' + (CX + halfW) + '" y2="' + CY + '" ' +
                'stroke="rgba(120,150,190,.06)"/>' +
                '<line x1="' + CX + '" y1="' + (CY - vbH / 2) + '" x2="' + CX + '" y2="' + (CY + vbH / 2) + '" ' +
                'stroke="rgba(120,150,190,.06)"/>';

        // ---- edges
        // Edge ids are keyed by index rather than by agent id: ids are harness
        // generated today, but interpolating arbitrary text into an SVG id/href
        // is a footgun waiting for a future data source.
        var edgeList = [];
        var particleList = [];
        Object.keys(pos).forEach(function (id) {
            var a = agents[id];
            if (!a || !a.parentId || !pos[a.parentId]) return;
            if (!shown[id] || !shown[a.parentId]) return;   // hidden agents keep their slot, not their edge
            var p = geoOf(a.parentId), q = geoOf(id);
            var active = a.status === 'working';
            var bursting = (state.bursts[id] || 0) > now;
            var colour = bursting ? COL.done : statusColor(a.status);

            var edge = { child: id, parent: a.parentId, line: null };
            var ei = edgeList.length;
            edgeList.push(edge);

            html += '<path class="edge' + (active ? ' active' : '') + '" data-ei="' + ei + '" ' +
                    'd="M' + p.x + ' ' + p.y + ' L' + q.x + ' ' + q.y + '" ' +
                    'stroke="' + colour + '" stroke-opacity="' + (active || bursting ? '.95' : '.26') + '" ' +
                    'stroke-width="' + (active || bursting ? 3 : 1.4) + '"/>';

            // Signals are dots lerped along the parent→child segment by the animation
            // loop, so they stay glued to both endpoints as the robots orbit. `m/n`
            // reproduces the staggering the old SMIL `begin` offsets produced.
            var addSignals = function (dir, n, dur, radius, tint) {
                for (var m = 0; m < n; m++) {
                    var ph = m / n;
                    var t0 = dir > 0 ? ph : 1 - ph;
                    var pi = particleList.length;
                    html += '<circle class="particle" data-pi="' + pi + '" r="' + radius +
                            '" fill="' + tint + '" filter="url(#glow)" cx="' +
                            (p.x + (q.x - p.x) * t0).toFixed(1) + '" cy="' +
                            (p.y + (q.y - p.y) * t0).toFixed(1) + '"/>';
                    particleList.push({ edge: edge, dir: dir, phase: ph, dur: dur, el: null });
                }
            };
            if (active) addSignals(1, 3, 1.6, 6, COL.working);
            if (bursting) addSignals(-1, 4, 1.1, 7, COL.done);
        });

        // ---- nodes
        var drawnNow = {};
        var nodeList = [];
        Object.keys(pos).forEach(function (id) {
            var a = agents[id];
            if (!a || !shown[id]) return;      // hidden agents hold their slot silently
            var p = pos[id];
            var isRoot = id === d.root.id;
            var colour = statusColor(a.status);
            var r = isRoot ? 50 : 40;

            // Finished agents dim with age so the eye lands on live ones.
            var opacity = 1;
            if (a.status === 'done') {
                var since = now - (state.finishedAt[id] || now);
                opacity = since > FADE_MS ? 0.45 : 1;
            }

            // Only genuinely new agents get the fade-in. The SVG is rebuilt from a
            // string every poll, so animating unconditionally would make every robot
            // blink on every poll.
            var fresh = !state.drawnNodes[id];
            drawnNow[id] = 1;

            var ni = nodeList.length;
            nodeList.push({ id: id, isRoot: isRoot, el: null, label: null, sub: null });

            // Children are in node-LOCAL coordinates: the group itself carries the
            // translate, and that is the one attribute the animation loop rewrites.
            html += '<g class="node' + (fresh ? ' node-new' : '') + '" data-ni="' + ni +
                    '" transform="translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')">';

            if (a.status === 'working') {
                html += '<circle class="node-ring pulse" r="' + r +
                        '" stroke="' + colour + '" stroke-width="2"/>';
            }
            // A soft disc so the robot reads against the dark background.
            html += '<circle r="' + (r + 5) + '" fill="' + colour +
                    '" opacity="' + (0.14 * opacity).toFixed(2) + '"/>';

            html += '<g opacity="' + opacity.toFixed(2) +
                    '" filter="url(#glow)">' + robot(r * 0.72, colour, '#08111c') + '</g>';

            var label = isRoot ? 'main' : (a.label || a.id);
            if (label.length > maxLen) label = label.slice(0, maxLen - 1) + '…';

            var bits = [];
            if (!isRoot) bits.push('d' + a.depth);
            bits.push(a.toolCalls + ' tools');
            if (a.errors) bits.push(a.errors + ' err');
            bits.push(dur(agentDur(a, d.now)));
            var sub = bits.join(' · ');

            if (isRoot) {
                html += '<text class="node-label" data-role="label" x="0" y="' + (r + 22) +
                        '" text-anchor="middle">' + esc(label) + '</text>';
                html += '<text class="node-sub" data-role="sub" x="0" y="' + (r + 37) +
                        '" text-anchor="middle">' + esc(sub) + '</text>';
                if (a.currentTool) {
                    html += '<text class="node-sub" x="0" y="' + (r + 53) +
                            '" text-anchor="middle" fill="' + COL.working + '">' +
                            esc(a.currentTool.name) + ' running…</text>';
                }
            } else {
                // Labels radiate outward, so neighbouring agents on a crowded ring
                // push their text apart instead of colliding.
                var lp = labelPoint(id);
                html += '<text class="node-label" data-role="label" x="' + lp.lx + '" y="' + lp.ly +
                        '" text-anchor="' + lp.anchor + '">' + esc(label) + '</text>';
                html += '<text class="node-sub" data-role="sub" x="' + lp.lx + '" y="' + (lp.ly + 15) +
                        '" text-anchor="' + lp.anchor + '">' + esc(sub) + '</text>';
            }

            html += '</g>';   // .node
        });

        state.drawnNodes = drawnNow;

        $('graph').innerHTML = html;

        // Re-acquire the refs the animation loop mutates: the assignment above threw
        // the old elements away. Indexed by position, so nothing has to be escaped
        // into a selector.
        var q = function (sel) { return $('graph').querySelector(sel); };
        edgeList.forEach(function (e, i) { e.line = q('[data-ei="' + i + '"]'); });
        particleList.forEach(function (pt, i) { pt.el = q('[data-pi="' + i + '"]'); });
        nodeList.forEach(function (nd, i) {
            nd.el = q('[data-ni="' + i + '"]');
            if (!nd.isRoot && nd.el) {
                nd.label = nd.el.querySelector('[data-role="label"]');
                nd.sub = nd.el.querySelector('[data-role="sub"]');
            }
        });
        state.gfx = { edges: edgeList, particles: particleList, nodes: nodeList };

        // Put everything where the physics already says it is, so a re-render never
        // flickers back to the slot angle for a frame.
        applyGfx();

        $('graph-hint').textContent = visible.length + ' shown · ' +
            ((d.summary && d.summary.working) || 0) + ' active' +
            (hidden ? ' · ' + hidden + ' finished hidden' : '');
    }

    // ---------------------------------------------------------------- feed
    function renderFeed(d) {
        var items = d.feed || [];
        var info = {};
        (d.agents || []).forEach(function (a) { info[a.id] = a; });
        info[d.root.id] = d.root;

        var html = '';
        items.forEach(function (e) {
            var key = e.agentId + '|' + e.time + '|' + e.kind + '|' + (e.summary || '') + '|' + e.status;
            var isNew = !state.seen[key];
            if (isNew) state.seen[key] = 1;

            var a = info[e.agentId];
            var who = shortName(a || { id: e.agentId }, e.agentId === d.root.id);
            // esc() the class parts too: today kind/status are fixed literals from
            // LiveMonitor, but they are interpolated into an attribute.
            var cls = 'k-' + esc(e.kind) +
                (e.status === 'error' ? ' st-error' : (e.status === 'running' ? ' st-running' : ''));

            html += '<li class="' + cls + '"' + (isNew ? '' : ' style="animation:none"') + '>' +
                '<div class="row1">' +
                  (e.status === 'running' ? '<span class="spinner"></span>' : '') +
                  '<span class="who" title="' + esc(a ? a.label : e.agentId) + '">' + esc(who) + '</span>' +
                  '<span class="kind">' + esc(e.kind) + (e.name ? ' · ' + esc(e.name) : '') + '</span>' +
                  '<span class="tm">' + esc(clock(e.time)) + '</span>' +
                '</div>' +
                '<div class="txt">' + esc(e.summary) + '</div>' +
              '</li>';
        });

        var list = $('feed');
        var old = list.scrollTop;
        list.innerHTML = html || '<li><div class="txt">no events yet</div></li>';
        $('feed-hint').textContent = items.length + ' recent';
        // Stay pinned to the top unless the user has scrolled down.
        list.scrollTop = old < 24 ? 0 : old;
    }

    // ---------------------------------------------------------------- now
    function renderNow(d) {
        var root = d.root, box = $('now');
        if (root.currentTool) {
            box.className = 'now';
            box.innerHTML = '<span class="now-label">running</span><span class="now-text">' +
                esc(root.currentTool.name + ' — ' + (root.currentTool.summary || '')) + '</span>';
        } else if (root.status === 'working') {
            box.className = 'now idle';
            box.innerHTML = '<span class="now-label">thinking</span><span class="now-text">' +
                esc(root.lastText ? root.lastText.slice(0, 200) : 'waiting for the model…') + '</span>';
        } else {
            box.className = 'now idle';
            box.innerHTML = '<span class="now-label">idle</span><span class="now-text">' +
                esc(root.lastText ? root.lastText.slice(0, 200) : 'no open turn') + '</span>';
        }
    }

    // ---------------------------------------------------------------- cards
    var PALETTE = ['#ffb454', '#4fa3ff', '#37c98b', '#a77bff', '#e879a8', '#35c9d6', '#7d8bff'];

    function renderCards(d) {
        var shown = visibleAgents(d);
        var html = shown.map(function (a) {
            var quiet = a.status === 'working' && a.quietMs > 90000;
            var tools = Object.keys(a.byTool || {});
            var total = tools.reduce(function (n, t) { return n + a.byTool[t]; }, 0) || 1;
            var bar = tools.slice(0, 7).map(function (t, i) {
                var pct = (a.byTool[t] / total) * 100;
                return '<i style="width:' + pct.toFixed(1) + '%;background:' + PALETTE[i % PALETTE.length] +
                       '" title="' + esc(t) + ': ' + a.byTool[t] + '"></i>';
            }).join('');

            var cur = a.currentTool
                ? a.currentTool.name + ' — ' + (a.currentTool.summary || '')
                : (a.lastText ? a.lastText.slice(0, 150) : 'no activity recorded');

            return '<div class="acard st-' + esc(a.status) + '">' +
                '<div class="hd"><span class="nm">' + esc(a.label || a.id) + '</span>' +
                '<span class="st">' + esc(a.status) + '</span></div>' +
                '<div class="meta">' +
                  '<span>' + (a.id === d.root.id ? 'root' : 'depth ' + a.depth) + '</span>' +
                  '<span>' + num(a.toolCalls) + ' tools</span>' +
                  (a.errors ? '<span style="color:#ff6b6b">' + a.errors + ' errors</span>' : '') +
                  '<span>' + dur(agentDur(a, d.now)) + '</span>' +
                  '<span>' + compact(a.tokens && a.tokens.outputTokens) + ' tok</span>' +
                '</div>' +
                '<div class="cur' + (quiet ? ' quiet' : '') + '">' + esc(cur) + '</div>' +
                '<div class="bar">' + bar + '</div>' +
              '</div>';
        }).join('');
        $('agent-cards').innerHTML = html || '<div class="acard">no agents</div>';
    }

    // ---------------------------------------------------------------- render
    function noteTransitions(d) {
        (d.agents || []).forEach(function (a) {
            var prevStatus = state.statuses[a.id];
            if (prevStatus === 'working' && a.status === 'done') {
                // Just handed its result back — fly a signal home to the parent.
                state.bursts[a.id] = d.now + BURST_MS;
                state.finishedAt[a.id] = d.now;
            } else if (prevStatus !== undefined && a.status === 'done'
                       && state.finishedAt[a.id] === undefined) {
                state.finishedAt[a.id] = d.now;
            }
            state.statuses[a.id] = a.status;
        });
    }

    function render(d) {
        if (!d || !d.ok) {
            $('root-title').textContent = (d && d.error) || 'no session data';
            return;
        }

        // Following a different session: drop all per-agent memory so bursts and
        // fade timers do not leak across.
        if (state.rootId !== d.rootId) {
            state.rootId = d.rootId;
            state.statuses = {};
            state.finishedAt = {};
            state.bursts = {};
            state.seen = {};
            state.slots = {};
            state.drawnNodes = {};
            state.orbit = {};        // velocities are per session, not per browser
            state.pairCool = {};     // and so are the collision cooldowns
            state.gfx = null;        // those refs point at the old session's elements
            state.prev = null;
            state.burn = 0;
            state.burnHistory = [];
        }

        $('root-title').textContent = (d.root.label || d.root.id) + '  ·  ' + d.rootId;

        var out = (d.root.tokens && d.root.tokens.outputTokens) || 0;
        if (state.prev && d.now > state.prev.at) {
            var dt = (d.now - state.prev.at) / 60000;
            var delta = out - state.prev.tokens;
            if (dt > 0 && delta >= 0) {
                state.burn = (delta / dt) * 0.5 + state.burn * 0.5;
                state.burnHistory.push(Math.round(state.burn));
                if (state.burnHistory.length > 40) state.burnHistory.shift();
            }
        }
        state.prev = { tokens: out, at: d.now };

        noteTransitions(d);
        renderTiles(d);
        renderGraph(d);
        renderFeed(d);
        renderNow(d);
        renderCards(d);
    }

    // ---------------------------------------------------------------- polling
    function tick() {
        $('clock').textContent = new Date().toTimeString().slice(0, 8);
    }

    function poll() {
        if (state.paused) return;
        // In follow mode we send no id, so the API hands back whichever session is
        // newest — a session started after this page loaded is picked up on the
        // next tick without a reload.
        var id = (!state.follow && state.data && state.data.rootId) ? state.data.rootId : '';
        fetch('api.php?action=live' + (id ? '&id=' + encodeURIComponent(id) : ''), { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                state.failures = 0;
                state.data = d;
                render(d);
            })
            .catch(function () {
                state.failures++;
                if (state.failures >= 3) $('root-title').textContent = 'connection lost — retrying…';
            });
    }

    $('pause').addEventListener('click', function () {
        state.paused = !state.paused;
        this.textContent = state.paused ? 'resume' : 'pause';
        $('live-dot').classList.toggle('paused', state.paused);
    });

    /** Reflect the finished-agents mode on its button. */
    function paintFinishedButton() {
        var btn = $('finished');
        btn.textContent = 'finished: ' + state.finishedMode;
        btn.classList.toggle('off', state.finishedMode === 'hidden');
        btn.title = state.finishedMode === 'auto'
            ? 'Finished agents leave 6s after they go quiet, and return if used again'
            : (state.finishedMode === 'shown'
                ? 'Every agent stays on screen'
                : 'Finished agents are never drawn');
    }

    $('finished').addEventListener('click', function () {
        // auto -> shown -> hidden -> auto
        var order = ['auto', 'shown', 'hidden'];
        state.finishedMode = order[(order.indexOf(state.finishedMode) + 1) % order.length];
        paintFinishedButton();
        render(state.data);
    });

    $('follow').addEventListener('click', function () {
        state.follow = !state.follow;
        this.textContent = 'follow: ' + (state.follow ? 'on' : 'off');
        this.classList.toggle('off', !state.follow);
        // Rejoining follow should not wait for the next tick.
        if (state.follow) poll();
    });

    paintFinishedButton();
    $('follow').textContent = 'follow: ' + (state.follow ? 'on' : 'off');
    $('follow').classList.toggle('off', !state.follow);

    render(state.data);
    if (motionEnabled()) requestAnimationFrame(frame);
    tick();
    setInterval(tick, 1000);
    setInterval(poll, POLL_MS);
    poll();
})();
