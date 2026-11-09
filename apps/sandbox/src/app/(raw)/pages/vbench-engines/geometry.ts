// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file geometry.ts
 * @input A scroller element (or null for the page) and the list element
 * @output Scroll geometry, scroll correction and the anchored row's index
 * @position Shared by the bench's offset-model adapters. Bench-only.
 */

import type {BenchStore} from './store';

export const HEADER_PX = 120;
export const OVERSCAN_PX = 400;

/** Scroll geometry for the list, from its scroller (an element or the page). */
export interface Geometry {
  scrollTop: number;
  viewport: number;
  /** Distance from the scroll origin to the list's first row. */
  startOffset: number;
}

export function readGeometry(
  scroller: HTMLElement | null,
  list: HTMLElement | null,
): Geometry {
  if (scroller) {
    const listTop = list
      ? list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      : 0;
    return {
      scrollTop: scroller.scrollTop,
      viewport: scroller.clientHeight,
      startOffset: listTop,
    };
  }
  const listTop = list
    ? list.getBoundingClientRect().top + window.scrollY
    : HEADER_PX;
  return {
    scrollTop: window.scrollY,
    viewport: window.innerHeight,
    startOffset: listTop,
  };
}

export function scrollBy(scroller: HTMLElement | null, delta: number) {
  if (delta === 0) {
    return;
  }
  if (scroller) {
    scroller.scrollTop += delta;
  } else {
    window.scrollTo(0, window.scrollY + delta);
  }
}

/** Keeps the anchored row still as sizes above it change (offset models). */
export function anchorIndex(
  store: BenchStore,
  model: {indexAt(y: number): number},
  geometry: Geometry,
): number {
  if (store.anchorMode === 'item' && store.anchorKey != null) {
    return store.indexOf(store.anchorKey);
  }
  return model.indexAt(geometry.scrollTop - geometry.startOffset);
}
