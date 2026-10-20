"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CampusItem, Decision } from "@/lib/types";
import { CampusCard, schedule } from "./campus-card";
import { Icon } from "./icon";

const THRESHOLD = 90;
const EXIT_MS = 240;
/** Keyboard swipes have no drag lead-in, so they glide out slower to read as a swipe. */
const KEY_EXIT_MS = 650;

export function SwipeCard({ item, next, onDecision, canUndo, onUndo }: { item: CampusItem; next?: CampusItem; onDecision: (decision: Decision) => Promise<boolean>; canUndo: boolean; onUndo: () => void }) {
  const [offset, setOffset] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [exitMs, setExitMs] = useState(EXIT_MS);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; offset: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const decideRef = useRef<(decision: Decision, ms?: number) => void>(() => {});
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function decide(decision: Decision, ms = EXIT_MS) {
    if (busy.current) return;
    busy.current = true;
    setExitMs(ms);
    setExiting(true);
    const distance = Math.max(window.innerWidth, 600);
    setOffset(decision === "interested" ? distance : -distance);
    // The deck advances right away; a swipe that can't be recorded locally brings the card back.
    timer.current = setTimeout(async () => {
      if (!await onDecision(decision)) {
        busy.current = false;
        setExiting(false);
        setOffset(0);
      }
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms);
  }
  useEffect(() => { decideRef.current = decide; });

  // Arrow keys swipe, like Tinder on the web. Ignored while typing in a field.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); decideRef.current("pass", KEY_EXIT_MS); }
      if (event.key === "ArrowRight") { event.preventDefault(); decideRef.current("interested", KEY_EXIT_MS); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function down(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || busy.current) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: 0, axis: "pending" };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (g.axis === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
      g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "horizontal" : "vertical";
    }
    if (g.axis === "horizontal") {
      g.offset = dx;
      setOffset(dx);
    }
  }
  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    // The browser may already have released capture (e.g. on cancel), which makes release throw.
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    if (!cancelled && g.axis === "horizontal" && Math.abs(g.offset) >= THRESHOLD) decide(g.offset > 0 ? "interested" : "pass");
    else setOffset(0);
  }

  function showDetails() {
    const details = document.getElementById("card-details");
    details?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    details?.focus({ preventScroll: true });
  }

  const progress = Math.min(Math.abs(offset) / THRESHOLD, 1);
  const leaning = Math.abs(offset) > 25 ? (offset > 0 ? "interested" : "pass") : null;
  const settle = exiting || offset === 0;

  return <div className="discover-layout">
    <div className="deck-column">
      <div className="deck">
        {next && <div className="deck-next" aria-hidden="true" style={{ transform: `scale(${0.94 + 0.06 * progress})`, transition: settle ? `transform ${exitMs}ms ease` : "none" }}><CampusCard item={next} /></div>}
        <div
          className={`swipe-surface ${exiting ? "exiting" : ""}`}
          data-testid="swipe-card"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={event => finish(event)}
          onPointerCancel={event => finish(event, true)}
          onLostPointerCapture={() => { if (gesture.current) { gesture.current = null; setOffset(0); } }}
          style={{ transform: `translateX(${offset}px) rotate(${offset / 22}deg)`, transition: settle ? `transform ${exitMs}ms ${exitMs > EXIT_MS ? "cubic-bezier(.45,0,.4,1)" : "cubic-bezier(.2,.7,.3,1)"}` : "none" }}
        >
          <CampusCard item={item} onInfo={showDetails} />
          <div aria-hidden="true" className={`swipe-tint ${offset > 0 ? "tint-like" : "tint-pass"}`} style={{ opacity: progress * 0.45 }} />
          {leaning && <div aria-hidden="true" className={`swipe-stamp ${leaning === "interested" ? "stamp-like" : "stamp-pass"}`} style={{ opacity: Math.min(1, progress * 1.4) }}>{leaning === "interested" ? "INTERESTED" : "PASS"}</div>}
        </div>
        <div className="deck-actions">
          <button disabled={exiting} aria-label="Pass" className={`round-button pass-button ${leaning === "pass" ? "armed" : ""}`} onClick={() => decide("pass")}><Icon name="close" size={30} strokeWidth={2.6} /></button>
          <button aria-disabled={exiting || !canUndo} className="round-button undo-button" aria-label="Go back to the previous card" onClick={() => { if (!exiting && canUndo) onUndo(); }}><Icon name="undo" size={22} strokeWidth={2.4} /></button>
          <button disabled={exiting} aria-label="Interested" className={`round-button like-button ${leaning === "interested" ? "armed" : ""}`} onClick={() => decide("interested")}><Icon name="heart" size={30} strokeWidth={2.4} /></button>
        </div>
      </div>
      <p className="key-hint"><span><kbd aria-label="Left arrow">←</kbd> Pass</span><span><kbd aria-label="Right arrow">→</kbd> Interested</span></p>
    </div>
    <section id="card-details" className="card-details" tabIndex={-1} aria-label={`Details for ${item.title}`} style={{ filter: `grayscale(${progress}) brightness(${1 - 0.32 * progress})`, transition: settle ? `filter ${exitMs}ms ease` : "none" }}>
      <h3>About this {item.kind}</h3>
      {item.description ? <p className="card-description">{item.description}</p> : <p className="card-description muted">The organizers haven’t added a description yet.</p>}
      {item.tags.length > 0 && <div className="tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
      <dl className="detail-list">
        <div><dt><Icon name="pin" size={18} /><span>Where</span></dt><dd>{item.location || "Location to come"}</dd></div>
        <div><dt><Icon name="clock" size={18} /><span>When</span></dt><dd>{schedule(item)}{item.kind === "event" && <small>Campus time, America/New_York</small>}</dd></div>
      </dl>
      {item.sourceUrl && <a className="text-link official-link" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">View the official listing</a>}
    </section>
  </div>;
}
