import React, { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
/**
 * FIXES APPLIED (production release bugs):
 *
 * 1. TEMPLATE AUTO-LOAD: The original check used `=== undefined` which works in
 *    development but FAILS in production — released blocks return `null` (not
 *    `undefined`) for unset globalConfig keys. Fixed to check `=== null || === undefined`.
 *    Also moved to run only once on mount (empty deps array) instead of re-running
 *    whenever rawElements changes, which could cause infinite re-writes.
 *
 * 2. IMAGE FETCHING (CORS): `fetch()` is blocked by CORS in Airtable's released
 *    block iframe. Replaced with `new Image()` + `crossOrigin='anonymous'` which
 *    works with Airtable's attachment CDN and gracefully handles tainted canvases.
 *
 * 3. PLACEHOLDER IMAGE: `via.placeholder.com` is an external URL that fails in the
 *    sandboxed iframe. Replaced with an inline SVG data URI.
 *
 * 4. STALE CLOSURE IN prepareRecordForPrint: The function captured stale `elements`
 *    and `imageCache` state at render time. Fixed using `useRef` mirrors so the
 *    function always reads the latest values. Also fixed the `useEffect` dependency
 *    to use `currentRecord?.id` for stable comparisons.
 *
 * 5. DRAGGABLE DISABLED BUG: `disabled={selectedStackChildId !== null}` was disabling
 *    ALL element dragging whenever any stack child was selected. Fixed to only disable
 *    the specific parent stack element whose child is currently selected.
 *
 * 6. BULK PDF RENDER TIMING: `sleep(800)` after `setRecordIndex` was not enough time
 *    for React to commit the new record to the DOM in production's slower iframe.
 *    Increased to 1200ms for reliability.
 *
 * 8. TEMPLATE SAVE / EXPORT / LIVE DEFAULT:
 *    Three new functions + sidebar UI for managing templates without redeploying:
 *    a) saveAsDefaultTemplate() — writes current elements+pageStyle to
 *       globalConfig('defaultTemplate'). This persists in the workspace and is
 *       used as the source for all future first-run installs, taking priority
 *       over the static template.json file.
 *    b) exportTemplateJSON() — downloads the current layout as a template.json
 *       file. Drop it into the project root and redeploy to bake it into the
 *       bundle as the permanent static fallback for installs outside this workspace.
 *    c) loadDefaultTemplate() — restores from globalConfig('defaultTemplate') if
 *       it exists, otherwise falls back to template.json. Replaces the old
 *       loadTemplate() which only ever read from the static file.
 *    The auto-load useEffect follows the same priority: globalConfig first, then
 *       template.json, so a saved default is always honoured.
 *
 * 7. FIELD ID MISMATCH (new base crash): The template.json was built against a specific
 *    base with specific field IDs (e.g. 'flddnO9RZOfhT2mEe'). When installed in any
 *    other base, those IDs don't exist and Airtable throws a hard crash:
 *    "Field 'flddnO9RZOfhT2mEe' does not exist in table".
 *    Fixed in three ways:
 *    a) `validateTemplateElements(elements, table)` checks each fieldId against the
 *       ACTUAL table via `getFieldByIdIfExists`. If it exists → keep it (own base,
 *       template loads fully). If not → null it (foreign base, layout loads blank).
 *       Previous version used `sanitizeTemplateElements` which blindly wiped ALL
 *       fieldIds, breaking the template even in the base it was built for.
 *    b) The auto-load useEffect is placed AFTER `table` is declared so the validator
 *       has a real table reference. It depends on `[table]` so it re-runs if the
 *       table resolves asynchronously on first render.
 *    c) `safeGetCellValue()` / `safeGetCellValueAsString()` provide a runtime safety
 *       net — every cell access checks field existence before calling the SDK, so
 *       any stale IDs that slip through produce blank values instead of crashes.
 */
import {
    initializeBlock,
    useBase,
    useRecords,
    useGlobalConfig,
    Box,
    Button,
    FormField,
    Input,
    Select,
    Text,
    FieldPicker,
    Heading,
    Label,
    Icon,
    Switch,
    Loader,
    Tooltip
} from '@airtable/blocks/ui';
import Draggable from 'react-draggable';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import templateData from './template.json';

// FIX (real crash — "ReferenceError: process is not defined" on any click):
// react-draggable's internal log() helper reads `process.env.DRAGGABLE_DEBUG` inside
// handleDragStart, which runs on the mousedown of every drag. Airtable's released-block
// bundle does not define `process`, so that bare lookup throws on the first click of any
// canvas element. Provide a minimal global shim so the env access simply resolves to
// undefined. (typeof on an undeclared identifier is safe and never throws.)
if (typeof process === 'undefined') {
    globalThis.process = { env: {} };
}

// 1. ASSETS
// Default fallback icon (Link chain)
const DEFAULT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cpath fill='%23333' d='M326.612 185.391c59.747 59.809 58.927 155.698.36 214.59-.11.12-.24.25-.36.37l-67.2 67.2c-59.27 59.27-155.699 59.262-214.96 0-59.27-59.26-59.27-155.7 0-214.96l37.106-37.106c9.84-9.84 26.786-3.3 27.294 10.606.648 17.722 3.826 35.527 9.69 52.721 1.986 5.822.567 12.262-3.783 16.612l-13.087 13.087c-28.026 28.026-28.905 73.66-1.155 101.96 28.024 28.579 74.086 28.749 102.325.51l67.2-67.19c28.191-28.191 28.073-73.757 0-101.83-3.701-3.694-7.429-6.564-10.341-8.569a16.037 16.037 0 0 1-6.947-12.606c-.396-10.567 3.348-21.456 11.698-29.806l21.054-21.055c5.521-5.521 14.182-6.199 20.584-1.731a152.482 152.482 0 0 1 20.522 17.197zM467.547 44.449c-59.261-59.262-155.69-59.27-214.96 0l-67.2 67.2c-.12.12-.25.25-.36.37-58.566 58.892-59.387 154.781.36 214.59a152.454 152.454 0 0 0 20.521 17.196c6.402 4.468 15.064 3.789 20.584-1.731l21.054-21.055c8.35-8.35 12.094-19.239 11.698-29.806a16.037 16.037 0 0 0-6.947-12.606c-2.912-2.005-6.64-4.875-10.341-8.569-28.073-28.073-28.191-73.639 0-101.83l67.2-67.19c28.239-28.239 74.3-28.069 102.325.51 27.75 28.3 26.872 73.934-1.155 101.96l-13.087 13.087c-4.35 4.35-5.769 10.79-3.783 16.612 5.864 17.194 9.042 34.999 9.69 52.721.509 13.906 17.454 20.446 27.294 10.606l37.106-37.106c59.271-59.26 59.271-155.69 0-214.96z'/%3E%3C/svg%3E";

const ICONS = {
    apple: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 384 512'%3E%3Cpath fill='%23fa243c' d='M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5c0 39.1 16.7 85.6 56.1 139.8 18.2 25.5 38.8 54.1 66.8 54.1 27.6 0 38.8-19.7 66.8-19.7 27.6 0 38.8 19.7 66.8 19.7 27.6 0 48.6-28.6 66.8-54.1 19.1-27.6 40-79.7 40-79.7-12.7-5.9-27.1-13.2-32.7-20.7-13.6-17.7-16-37.7-16.1-44.2zM245.9 94.2c15.8-24.4 30.7-58.5 28.1-89.8-31 1.2-65.7 17.6-83.3 39.8-14.9 18.1-30.6 57.3-25.3 87 34.3 3.8 64.7-12.6 80.5-37z'/%3E%3C/svg%3E",
    spotify: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 496 512'%3E%3Cpath fill='%231DB954' d='M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8zm100.7 364.9c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4zm26.9-65.6c-5.2 0-8.7-2.3-12.3-4.2-62.5-40.1-140.4-43.6-212.6-29.8-8.2 1.5-13.5 1.5-18.1 1.5-13.9 0-22.1-10.3-22.1-21.4 0-12.8 8.8-21.4 19.9-23.7 85-18 177.3-14.7 253.2 29.8 4.2 2.6 10.3 7.1 10.3 17.8 0 13.6-11.3 22.8-26.4 22.8zM413 221c-72.2-47.5-186.2-54.8-257.2-29.8-12.3 4.4-18.1 4.4-23.7 4.4-19.1 0-32.5-14.7-32.5-33.1 0-18.6 12.3-30.6 30.6-35.8 83.1-29.3 216.7-21.4 304.4 33.1 7.7 4.6 13.4 9.3 13.4 21.1s-13.9 24.3-27.1 24.3z'/%3E%3C/svg%3E",
    instagram: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 448 512'%3E%3Cpath fill='%23C13584' d='M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z'/%3E%3C/svg%3E",
    youtube: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 576 512'%3E%3Cpath fill='%23FF0000' d='M549.655 124.083c-6.281-23.65-24.787-42.276-48.284-48.597C458.781 64 288 64 288 64S117.22 64 74.629 75.486c-23.497 6.322-42.003 24.947-48.284 48.597-11.412 42.867-11.412 132.305-11.412 132.305s0 89.438 11.412 132.305c6.281 23.65 24.787 41.5 48.284 47.821C117.22 448 288 448 288 448s170.78 0 213.371-11.486c23.497-6.321 42.003-24.171 48.284-47.821 11.412-42.867 11.412-132.305 11.412-132.305s0-89.438-11.412-132.305zm-317.51 213.508V175.185l142.739 81.205-142.739 81.201z'/%3E%3C/svg%3E",
    soundcloud: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 512'%3E%3Cpath fill='%23ff5500' d='M111.4 256.3l5.6 65.2c2.1 24.2 8.7 46.2 18.2 64.9.4.8.8 1.6 1.2 2.4.9 1.7 1.7 3.4 2.7 5.1 18.9 33.3 54.1 56 94.6 56h.8c.2 0 .4 0 .5-.1 1.7-.1 3.4-.2 5.1-.4 26.6-2.2 50.8-12.2 70.3-27.9 22.1-17.7 38.3-43 42.7-72.3 1.2-8.3 1.9-16.8 1.9-25.5 0-16.7-2.6-32.7-7.4-47.7-2.8-8.8-6.4-17.1-10.7-25-10.4-19.1-25.2-35.3-43-47.3-26.6-18-58.8-28.7-93.5-28.7-32.6 0-63 9.4-88.7 25.6-1.9 1.2-3.8 2.5-5.6 3.8-1.7-5.9-3.7-11.5-5.9-17-7.7-19.1-19.1-36.1-33.1-50.1-28.8-28.8-67.6-44.6-108.3-44.6S16.2 51.5-12.6 80.3C-14.7 82.4-16.7 84.6-18.7 86.8c-.8.9-1.6 1.8-2.4 2.8C5 130.1 27.2 178.4 59.8 221.3c8.8 11.6 18.7 22.4 29.5 32.4 12.3 11.4 26 21.6 40.7 30.3l-18.6-27.7zm414 16.3c0-48.4-39.2-87.6-87.6-87.6-12 0-23.4 2.4-33.9 6.8 3.5 10.3 5.4 21.3 5.4 32.7 0 54.8-44.4 99.2-99.2 99.2-2.3 0-4.6-.1-6.9-.2-21.6 50.6-72.2 86.4-131 86.4H134.4C60.2 409.9 0 349.7 0 275.5S60.2 141.1 134.4 141.1c8.1 0 16 .8 23.7 2.3 13.9-38.6 50.8-65.8 94.3-65.8 36.6 0 69 19.3 87.7 48.7 13.7-6.5 29-10.2 45.1-10.2 60.1 0 108.8 48.7 108.8 108.8 0 8.7-1 17.1-3 25.2 21.9 8.2 37.4 29.3 37.4 54 0 31.8-25.8 57.6-57.6 57.6h-27.9c-2.4-48.7-41.9-87.6-91.1-87.6zM525.4 272.6c0 14.2 11.5 25.7 25.7 25.7h27.9c17.7 0 32-14.3 32-32s-14.3-32-32-32h-27.9c-14.2 0-25.7 11.5-25.7 25.7zm-40-108.8c0-45.9-37.3-83.2-83.2-83.2-12.2 0-23.8 2.7-34.4 7.6 15.3 22.4 24.4 49.7 24.4 79.2 0 8.6-.8 17-2.3 25.1 7.3-1.6 14.9-2.5 22.7-2.5 36.3 0 67.9 20.3 85 50.7 1.5-6 2.3-12.3 2.3-18.7.1-32.2-26-58.2-58.1-58.2z'/%3E%3C/svg%3E",
    tiktok: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 448 512'%3E%3Cpath fill='%23000000' d='M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z'/%3E%3C/svg%3E",
    link: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cpath fill='%23333' d='M326.612 185.391c59.747 59.809 58.927 155.698.36 214.59-.11.12-.24.25-.36.37l-67.2 67.2c-59.27 59.27-155.699 59.262-214.96 0-59.27-59.26-59.27-155.7 0-214.96l37.106-37.106c9.84-9.84 26.786-3.3 27.294 10.606.648 17.722 3.826 35.527 9.69 52.721 1.986 5.822.567 12.262-3.783 16.612l-13.087 13.087c-28.026 28.026-28.905 73.66-1.155 101.96 28.024 28.579 74.086 28.749 102.325.51l67.2-67.19c28.191-28.191 28.073-73.757 0-101.83-3.701-3.694-7.429-6.564-10.341-8.569a16.037 16.037 0 0 1-6.947-12.606c-.396-10.567 3.348-21.456 11.698-29.806l21.054-21.055c5.521-5.521 14.182-6.199 20.584-1.731a152.482 152.482 0 0 1 20.522 17.197zM467.547 44.449c-59.261-59.262-155.69-59.27-214.96 0l-67.2 67.2c-.12.12-.25.25-.36.37-58.566 58.892-59.387 154.781.36 214.59a152.454 152.454 0 0 0 20.521 17.196c6.402 4.468 15.064 3.789 20.584-1.731l21.054-21.055c8.35-8.35 12.094-19.239 11.698-29.806a16.037 16.037 0 0 0-6.947-12.606c-2.912-2.005-6.64-4.875-10.341-8.569-28.073-28.073-28.191-73.639 0-101.83l67.2-67.19c28.239-28.239 74.3-28.069 102.325.51 27.75 28.3 26.872 73.934-1.155 101.96l-13.087 13.087c-4.35 4.35-5.769 10.79-3.783 16.612 5.864 17.194 9.042 34.999 9.69 52.721.509 13.906 17.454 20.446 27.294 10.606l37.106-37.106c59.271-59.26 59.271-155.69 0-214.96z'/%3E%3C/svg%3E"
};

// 2. CONSTANTS & DEFAULTS
const DEFAULT_PAGE_WIDTH = 842; 
const DEFAULT_PAGE_HEIGHT = 595; 
const DEFAULT_ELEMENT_STYLE = {
    fontSize: '14px',
    fontFamily: 'Helvetica, Arial, sans-serif',
    fontWeight: 'normal', 
    color: '#000000',
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderWidth: '0px',
    textAlign: 'left',
    padding: '5px',
    borderStyle: 'solid',
    zIndex: 1,
};

// Curated, modern typefaces. `google` is the Google Fonts css2 family spec used to
// build the stylesheet link (null = system font, no fetch). `value` is the CSS
// font-family applied to elements. Add/remove here and both the loader and the
// pickers update automatically.
const FONT_CATALOG = [
    { value: 'Helvetica, Arial, sans-serif',     label: 'Helvetica (system)',  google: null },
    { value: '"Times New Roman", Times, serif',  label: 'Times (system)',      google: null },
    { value: '"Inter", sans-serif',              label: 'Inter',               google: 'Inter:wght@400;500;700' },
    { value: '"Roboto", sans-serif',             label: 'Roboto',              google: 'Roboto:wght@400;500;700' },
    { value: '"Manrope", sans-serif',            label: 'Manrope',             google: 'Manrope:wght@400;500;700' },
    { value: '"Poppins", sans-serif',            label: 'Poppins',             google: 'Poppins:wght@400;500;700' },
    { value: '"Montserrat", sans-serif',         label: 'Montserrat',          google: 'Montserrat:wght@400;500;700' },
    { value: '"DM Sans", sans-serif',            label: 'DM Sans',             google: 'DM+Sans:wght@400;500;700' },
    { value: '"Space Grotesk", sans-serif',      label: 'Space Grotesk',       google: 'Space+Grotesk:wght@400;500;700' },
    { value: '"Sora", sans-serif',               label: 'Sora',                google: 'Sora:wght@400;500;700' },
    { value: '"Outfit", sans-serif',             label: 'Outfit',              google: 'Outfit:wght@400;500;700' },
    { value: '"Archivo", sans-serif',            label: 'Archivo',             google: 'Archivo:wght@400;500;700' },
    { value: '"Oswald", sans-serif',             label: 'Oswald (condensed)',  google: 'Oswald:wght@400;500;700' },
    { value: '"Bebas Neue", sans-serif',         label: 'Bebas Neue (display)', google: 'Bebas+Neue' },
    { value: '"Anton", sans-serif',              label: 'Anton (display)',     google: 'Anton' },
];
const FONT_OPTIONS = FONT_CATALOG.map(f => ({ value: f.value, label: f.label }));

const DEFAULT_PAGE_STYLE = {
    type: 'solid', 
    color1: '#ffffff',
    color2: '#f0f0f0', 
    imageUrl: '',
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT
};

const SNAP_THRESHOLD = 5; 

// --- SAFETY HELPERS ---
// FIX: getCellValue/getCellValueAsString throw a hard error if the fieldId
// doesn't exist in the table (common when a template is loaded into a new base
// whose field IDs are completely different). These wrappers check existence first.
const fieldExistsInTable = (table, fieldId) => {
    if (!table || !fieldId) return false;
    return table.getFieldByIdIfExists(fieldId) !== null;
};

const safeGetCellValue = (record, table, fieldId) => {
    if (!record || !table || !fieldId) return null;
    if (!fieldExistsInTable(table, fieldId)) return null;
    try { return record.getCellValue(fieldId); } catch { return null; }
};

const safeGetCellValueAsString = (record, table, fieldId) => {
    if (!record || !table || !fieldId) return '';
    if (!fieldExistsInTable(table, fieldId)) return '';
    try { return record.getCellValueAsString(fieldId); } catch { return ''; }
};

// Returns a record's value(s) for a field as an array of option/value NAMES.
// Works across single-select (one name), multiple-select / linked (many names),
// and plain text (the string itself). Used by the value-based roster filter.
const getFieldValueNames = (record, table, fieldId) => {
    if (!record || !fieldExistsInTable(table, fieldId)) return [];
    let raw;
    try { raw = record.getCellValue(fieldId); } catch { return []; }
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw.map(v => (v && typeof v === 'object' ? v.name : v)).filter(x => typeof x === 'string');
    if (typeof raw === 'object') return typeof raw.name === 'string' ? [raw.name] : [];
    return [String(raw)];
};

// Decode the literal escape sequences a user can type into a find/replace box
// (\n -> newline, \t -> tab, \\ -> backslash) so they can insert line breaks.
const decodeEscapes = (s) => {
    if (!s) return '';
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            if (n === 'n') { out += '\n'; i++; continue; }
            if (n === 't') { out += '\t'; i++; continue; }
            if (n === '\\') { out += '\\'; i++; continue; }
        }
        out += s[i];
    }
    return out;
};

// Apply an element's find/replace rules to its displayed text. Literal (not regex)
// replacement of all occurrences, in order. \n in either side becomes a real break.
const applyReplacements = (text, rules) => {
    if (text == null || !Array.isArray(rules) || rules.length === 0) return text;
    let out = String(text);
    for (const r of rules) {
        if (!r) continue;
        const find = decodeEscapes(r.find);
        if (find === '') continue; // empty find would explode into every gap
        out = out.split(find).join(decodeEscapes(r.replace || ''));
    }
    return out;
};

// Validate template elements against the actual table.
// Keeps fieldIds that exist in THIS table, nulls only those that don't.
// This way the template works perfectly in its own base, and degrades gracefully
// (blank fields awaiting re-mapping) in any other base.
const validateTemplateElements = (elements, table) => {
    if (!Array.isArray(elements)) return [];
    const checkField = (fieldId) => {
        if (!fieldId || !table) return null;
        return table.getFieldByIdIfExists(fieldId) ? fieldId : null;
    };
    return elements.map(el => {
        const validated = { ...el, fieldId: checkField(el.fieldId) };
        if (Array.isArray(el.children)) {
            validated.children = el.children.map(child => ({
                ...child,
                fieldId: checkField(child.fieldId)
            }));
        }
        return validated;
    });
};

// --- HELPER: Fetch image and return Base64 Data URL ---
// FIX: Use Image element with crossOrigin instead of fetch()+blob.
// Airtable's released block iframe blocks fetch() for external URLs (CORS),
// but img.crossOrigin = 'anonymous' works with Airtable's attachment CDN.
const fetchImageAsBase64 = (url) => {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1600;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_SIZE) { height = Math.round(height * MAX_SIZE / width); width = MAX_SIZE; }
                } else {
                    if (height > MAX_SIZE) { width = Math.round(width * MAX_SIZE / height); height = MAX_SIZE; }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png'));
            } catch (err) {
                // Canvas tainted (CORS) — return null and fall back to direct URL
                console.warn("Canvas tainted for:", url, err);
                resolve(null);
            }
        };
        img.onerror = () => {
            console.warn("Failed to load image for base64 conversion:", url);
            resolve(null);
        };
        img.src = url;
    });
};

// Bake a blurred raster from a (same-origin) base64 image. CSS filter:blur() is
// ignored by html2canvas, so the blurred backdrop must be a real image to survive
// PDF export. Small + JPEG since it's only ever shown blurred. Returns null on
// failure (caller falls back to the unblurred photo).
const generateBlurredDataUrl = (base64, { width = 240, blur = 14 } = {}) => {
    return new Promise((resolve) => {
        if (!base64) { resolve(null); return; }
        try {
            const img = new Image();
            img.onload = () => {
                try {
                    const ar = (img.width && img.height) ? (img.width / img.height) : 1;
                    const w = width;
                    const h = Math.max(1, Math.round(width / (ar || 1)));
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    const o = Math.ceil(blur * 2); // overscan so the blurred edges stay covered
                    if ('filter' in ctx) ctx.filter = `blur(${blur}px)`;
                    ctx.drawImage(img, -o, -o, w + 2 * o, h + 2 * o);
                    resolve(canvas.toDataURL('image/jpeg', 0.6));
                } catch (e) { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = base64;
        } catch (e) { resolve(null); }
    });
};

// --- AUTO-FIT TEXT ---
// Renders text that shrinks its font size (never grows past the configured size)
// until it fits inside its box on BOTH axes. Used for bios and any field whose
// length varies record-to-record. The fit runs in a layout effect via a binary
// search on the live DOM node, so it settles synchronously before the browser
// paints — which means the PDF capture (which waits for paint) always sees the
// final size, on every record in a bulk export.
const AUTOFIT_MIN_PX = 5;
function AutoFitText({ text, baseFontSize, boxW, boxH, whiteSpace }) {
    const ref = useRef(null);
    const startSize = parseFloat(baseFontSize) || 14;
    const [fontSize, setFontSize] = useState(startSize);
    const rafRef = useRef(0);
    const lastSizeRef = useRef('');

    useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;

        // Apply the chosen size BOTH imperatively (so the current frame paints the
        // final size — no flash to full size) and via state (so React stays in sync).
        const apply = (px) => {
            node.style.fontSize = px + 'px';
            setFontSize(px);
        };

        const fit = () => {
            if (node.clientHeight <= 0 || node.clientWidth <= 0) return; // not laid out yet
            const fits = () => node.scrollHeight <= node.clientHeight + 0.5
                && node.scrollWidth <= node.clientWidth + 0.5;

            node.style.fontSize = startSize + 'px';
            if (fits()) { apply(startSize); return; }

            let lo = AUTOFIT_MIN_PX, hi = startSize, best = AUTOFIT_MIN_PX;
            for (let i = 0; i < 16 && hi - lo > 0.25; i++) {
                const mid = (lo + hi) / 2;
                node.style.fontSize = mid + 'px';
                if (fits()) { best = mid; lo = mid; } else { hi = mid; }
            }
            apply(best);
        };

        // Coalesce re-fits to once per frame, and ignore notifications where the box
        // size didn't actually change (font changes don't resize the node, so this
        // also prevents any observer feedback).
        const scheduleFit = () => {
            const key = node.clientWidth + 'x' + node.clientHeight;
            if (key === lastSizeRef.current) return;
            lastSizeRef.current = key;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(fit);
        };

        lastSizeRef.current = node.clientWidth + 'x' + node.clientHeight;
        fit();

        let ro = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(scheduleFit);
            ro.observe(node);
        }
        return () => {
            if (ro) ro.disconnect();
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [text, startSize, boxW, boxH]);

    return (
        <div
            ref={ref}
            style={{
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                wordWrap: 'break-word',
                whiteSpace: whiteSpace || 'normal',
                fontSize: fontSize + 'px'
            }}
        >
            {text}
        </div>
    );
}

// Downscale + re-encode a data URL so large uploads don't blow past globalConfig's
// size limit. Falls back to the original on any failure.
const downscaleImageDataUrl = (dataUrl, maxSize = 1600, quality = 0.85) => {
    return new Promise((resolve) => {
        try {
            const img = new Image();
            img.onload = () => {
                try {
                    let w = img.width, h = img.height;
                    if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } }
                    else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(c.toDataURL('image/jpeg', quality));
                } catch (e) { resolve(dataUrl); }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        } catch (e) { resolve(dataUrl); }
    });
};

// Approximate the stored byte size of a data URL (base64 ~= 4/3 of the bytes).
const dataUrlBytes = (dataUrl) => {
    if (!dataUrl) return 0;
    const i = dataUrl.indexOf(',');
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    return Math.floor(b64.length * 3 / 4);
};
const formatBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

// --- Nested-stack tree helpers. A stack's children may themselves be stacks, so
// items are addressed by a PATH of child ids from the root element down. [] = root.
const getChildByPath = (root, path) => {
    let node = root;
    for (let i = 0; i < (path || []).length; i++) {
        if (!node || !Array.isArray(node.children)) return null;
        node = node.children.find(c => c.id === path[i]);
    }
    return node || null;
};
const updateChildByPath = (root, path, updater) => {
    if (!path || path.length === 0) return updater(root);
    const [head, ...rest] = path;
    return { ...root, children: (root.children || []).map(c => c.id === head ? updateChildByPath(c, rest, updater) : c) };
};
const removeChildByPath = (root, path) => {
    if (!path || path.length === 0) return root;
    const parentPath = path.slice(0, -1);
    const targetId = path[path.length - 1];
    return updateChildByPath(root, parentPath, (parent) => ({ ...parent, children: (parent.children || []).filter(c => c.id !== targetId) }));
};
const pathsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// Catches render-time errors so one bad element/field can't white-screen the whole
// extension (as the earlier `process`-undefined crash did). Shows the error + recovery.
class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) { console.error("Roster Builder render error:", error, info); }
    render() {
        if (this.state.error) {
            const msg = (this.state.error && this.state.error.message) ? this.state.error.message : String(this.state.error);
            return (
                <div style={{ padding: '24px', fontFamily: 'Helvetica, Arial, sans-serif', maxWidth: '640px' }}>
                    <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
                    <p style={{ color: '#555', marginTop: 0 }}>
                        The extension hit an error and stopped rendering. "Try again" re-renders; if it keeps happening, reload.
                    </p>
                    <pre style={{ whiteSpace: 'pre-wrap', background: '#fbeaea', color: '#a32d2d', padding: '12px', borderRadius: '6px', fontSize: '12px' }}>{msg}</pre>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => this.setState({ error: null })} style={{ padding: '8px 14px', cursor: 'pointer' }}>Try again</button>
                        <button onClick={() => window.location.reload()} style={{ padding: '8px 14px', cursor: 'pointer' }}>Reload</button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

function UpgradedPageDesigner() {
    // 2. STATE MANAGEMENT
    const base = useBase();
    const globalConfig = useGlobalConfig();
    
    // --- SAVED DATA ---
    // Roster vs. standalone title page. The title page is a single slide prepended to
    // the bulk export; it reuses the ENTIRE editor by swapping which globalConfig keys
    // back the elements + page style. exportMode forces a render target during export
    // regardless of what the editor is currently showing.
    const [designMode, setDesignMode] = useState('roster'); // 'roster' | 'title'
    const [exportMode, setExportMode] = useState(null);      // null | 'roster' | 'title'
    const activeMode = exportMode || designMode;
    const elementsKey = activeMode === 'title' ? 'titleElements' : 'elements';
    const pageStyleKey = activeMode === 'title' ? 'titlePageStyle' : 'pageStyle';

    const rawElements = globalConfig.get(elementsKey);
    const elements = Array.isArray(rawElements) ? rawElements : [];

    const rawPageStyle = globalConfig.get(pageStyleKey);
    const pageStyle = rawPageStyle ? { ...DEFAULT_PAGE_STYLE, ...rawPageStyle } : DEFAULT_PAGE_STYLE;

    const titlePageEnabled = globalConfig.get('titlePageEnabled') !== false; // default on once created
    const titlePageExists = !!globalConfig.get('titlePageStyle');

    // Persisted value-based record filter, e.g. { fieldId, values: ['Shortlist','Ready'] }.
    // Saved with the template so the roster auto-scopes on load. null = no restriction.
    const rawRosterFilter = globalConfig.get('rosterFilter');
    const rosterFilter = (rawRosterFilter && rawRosterFilter.fieldId) ? rawRosterFilter : null;
    const updateRosterFilter = async (next) => {
        try {
            await globalConfig.setAsync('rosterFilter', next);
        } catch (err) {
            console.warn("Could not save roster filter", err);
            alert("Couldn't save the roster filter. You may need creator permissions.");
        }
    };

    // --- LOCAL UI STATE ---
    const storedTableId = globalConfig.get('selectedTableId');
    const defaultTableId = base.tables.length > 0 ? base.tables[0].id : null;
    const [selectedTableId, setSelectedTableId] = useState(storedTableId || defaultTableId);
    
    const [selectedElementId, setSelectedElementId] = useState(null);
    const [selectedChildPath, setSelectedChildPath] = useState([]); // path of child ids into a stack; [] = the root element itself
    const selectedStackChildId = selectedChildPath.length ? selectedChildPath[selectedChildPath.length - 1] : null; // derived: truthy iff a child is selected
    const [selectedIds, setSelectedIds] = useState([]); // multi-select: ids highlighted/organized together
    const [editMode, setEditMode] = useState('elements'); 
    
    const [recordIndex, setRecordIndex] = useState(0);
    const [isExporting, setIsExporting] = useState(false);
    const [sessionImage, setSessionImage] = useState(null);
    const [imageCache, setImageCache] = useState({}); 
    const [blurCache, setBlurCache] = useState({}); // url -> baked blurred data URL (for blur-fill)
    // When exporting one PDF per filter value, this temporarily scopes BOTH the roster
    // and the title page's {filter} token to a single value. null = use the saved filter.
    const [filterValueOverride, setFilterValueOverride] = useState(null);

    // --- FILTER & SEARCH STATE ---
    const [searchName, setSearchName] = useState('');
    // Multi-field filters: array of { id, fieldId, keyword }
    const [filters, setFilters] = useState([]);
    const [exportProgress, setExportProgress] = useState('');

    // --- SORT STATE ---
    // Sort by any field (incl. the primary / artist name). null = table's natural order.
    const [sortFieldId, setSortFieldId] = useState(null);
    const [sortDirection, setSortDirection] = useState('asc');

    // --- MANAGER CLIENT EDITOR STATE ---
    const [managerPanelOpen, setManagerPanelOpen] = useState(false);
    const [managerFieldId, setManagerFieldId] = useState(null);   // field that holds manager name
    const [clientsFieldId, setClientsFieldId] = useState(null);   // field that holds client list
    const [managerEditingId, setManagerEditingId] = useState(null); // record being edited
    const [managerEditValue, setManagerEditValue] = useState('');
    const [managerSaving, setManagerSaving] = useState(false);

    // useCurrentUser is not available in this SDK version.
    // Manager identity is captured via a manual name input stored in globalConfig.
    const storedManagerName = globalConfig.get('managerName') || '';
    const [managerName, setManagerName] = useState(storedManagerName);
    const saveManagerName = async (name) => {
        setManagerName(name);
        await globalConfig.setAsync('managerName', name);
    };

    // --- RESIZING & DRAGGING STATE ENGINE ---
    const [resizingState, setResizingState] = useState(null); 
    const [draggingState, setDraggingState] = useState(null); 
    const [groupDrag, setGroupDrag] = useState(null); // {id: {x,y}} live positions during a multi-select move
    const groupStartRef = useRef(null);
    const [dropTargetStackId, setDropTargetStackId] = useState(null); // stack currently under a dragged element (drag-to-add highlight)
    const [guides, setGuides] = useState([]); 

    // Data Fetching
    const table = base.getTableByIdIfExists(selectedTableId);
    // Sort via the SDK so each field type (text, number, date, etc.) sorts correctly.
    // Guard against a stale/foreign sortFieldId by resolving it against the live table.
    const sortField = (sortFieldId && table) ? table.getFieldByIdIfExists(sortFieldId) : null;
    const recordQueryOpts = useMemo(
        () => (sortField ? { sorts: [{ field: sortField, direction: sortDirection }] } : undefined),
        [sortField, sortDirection]
    );
    const records = useRecords(table, recordQueryOpts);

    // --- AUTO-LOAD TEMPLATE ON FIRST RUN ---
    // Priority: (1) saved defaultTemplate in globalConfig, (2) static template.json.
    // A template saved via "Save as Default" persists in globalConfig and is used
    // for all future first-runs in this workspace — no redeploy needed.
    useEffect(() => {
        const isFirstRun = rawElements === undefined || rawElements === null;
        if (!isFirstRun) return;

        const applyTemplate = async () => {
            const savedDefault = globalConfig.get('defaultTemplate');
            const source = savedDefault || templateData;
            if (!source) return;

            console.log(`First run — loading from: ${savedDefault ? 'saved defaultTemplate' : 'template.json'}`);
            try {
                if (source.elements) {
                    await globalConfig.setAsync(
                        'elements',
                        validateTemplateElements(source.elements, table)
                    );
                }
                if (source.pageStyle) {
                    await globalConfig.setAsync('pageStyle', source.pageStyle);
                }
                console.log("Template loaded successfully.");
            } catch (err) {
                console.error("Failed to auto-load template:", err);
            }
        };
        applyTemplate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [table]);
    
    // 1. MULTI-FILTER LOGIC — all active filters are ANDed together
    const activeFilters = filters.filter(f => f.fieldId && f.keyword.trim());

    // Value-based roster filter. Only restricts when it points at a field that
    // exists in THIS table AND has at least one value selected — otherwise it is
    // ignored (so loading a template whose filter field is from another base, or
    // selecting no values, never hides the entire roster by surprise).
    // Top-toolbar filter that drives the dynamic title text + per-value export. The
    // first top filter row with a field chosen designates the field; its typed keyword
    // (if any) is the live {filter} value.
    const topFilterRow = filters.find(f => f.fieldId) || null;
    const topFilterField = (topFilterRow && table) ? table.getFieldByIdIfExists(topFilterRow.fieldId) : null;
    const topFilterKeyword = (topFilterRow && topFilterRow.keyword) ? topFilterRow.keyword.trim() : '';

    const rosterFilterActive = !!(rosterFilter
        && fieldExistsInTable(table, rosterFilter.fieldId)
        && Array.isArray(rosterFilter.values)
        && rosterFilter.values.length > 0);

    const filteredRecords = records ? records.filter(record => {
        const passesKeyword = activeFilters.every(f => {
            const cellValue = safeGetCellValueAsString(record, table, f.fieldId);
            return cellValue.toLowerCase().includes(f.keyword.toLowerCase());
        });
        if (!passesKeyword) return false;
        if (rosterFilterActive) {
            const names = getFieldValueNames(record, table, rosterFilter.fieldId);
            if (!names.some(n => rosterFilter.values.includes(n))) return false;
        }
        // Per-value export scopes the roster to one exact value of a chosen field.
        if (filterValueOverride && filterValueOverride.fieldId) {
            const names = getFieldValueNames(record, table, filterValueOverride.fieldId);
            if (!names.includes(filterValueOverride.value)) return false;
        }
        return true;
    }) : [];

    // Live handle on the current filtered list so the async per-value export loop can
    // read each value's subset after a re-render without a stale closure.
    const filteredRecordsRef = useRef(filteredRecords);
    filteredRecordsRef.current = filteredRecords;

    // Text for a title element's {filter} token: the export override value, else the
    // live top-filter keyword, else the element's own default.
    const computeFilterText = (el) => {
        if (filterValueOverride && filterValueOverride.value) return filterValueOverride.value;
        if (topFilterKeyword) return topFilterKeyword;
        return (el && el.filterDefault) || '';
    };

    const currentRecord = filteredRecords[recordIndex];

    // Roster filter panel data: the chosen field + its selectable values.
    const rosterFilterField = (rosterFilter && fieldExistsInTable(table, rosterFilter.fieldId))
        ? table.getFieldByIdIfExists(rosterFilter.fieldId) : null;
    const rosterFilterValues = (rosterFilter && Array.isArray(rosterFilter.values)) ? rosterFilter.values : [];
    let rosterAvailableValues = [];
    if (rosterFilterField) {
        const choices = (rosterFilterField.options && Array.isArray(rosterFilterField.options.choices))
            ? rosterFilterField.options.choices : null;
        if (choices) {
            rosterAvailableValues = choices.map(c => c.name);
        } else if (records) {
            rosterAvailableValues = [...new Set(records.flatMap(r => getFieldValueNames(r, table, rosterFilter.fieldId)))].sort();
        }
    }
    const setRosterFilterField = (field) => updateRosterFilter(field ? { fieldId: field.id, values: [] } : null);
    const toggleRosterValue = (value) => {
        if (!rosterFilter) return;
        const exists = rosterFilterValues.includes(value);
        const nextValues = exists ? rosterFilterValues.filter(v => v !== value) : [...rosterFilterValues, value];
        updateRosterFilter({ fieldId: rosterFilter.fieldId, values: nextValues });
    };

    useEffect(() => {
        setRecordIndex(0);
    }, [JSON.stringify(filters), sortFieldId, sortDirection, JSON.stringify(rosterFilter)]);

    const addFilter = () => {
        setFilters(prev => [...prev, { id: Date.now().toString(), fieldId: null, keyword: '' }]);
    };

    const updateFilter = (id, updates) => {
        setFilters(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
        setRecordIndex(0);
    };

    const removeFilter = (id) => {
        setFilters(prev => prev.filter(f => f.id !== id));
    };

    const clearAllFilters = () => setFilters([]);

    // ── MANAGER CLIENT EDITOR ──────────────────────────────────────────────
    // Returns only records where the manager field matches the current user's name.
    const myManagerRecords = records && managerFieldId && managerName.trim()
        ? records.filter(record => {
            const val = safeGetCellValueAsString(record, table, managerFieldId);
            return val.toLowerCase().includes(managerName.trim().toLowerCase());
        })
        : [];

    const startEditingClient = (record) => {
        setManagerEditingId(record.id);
        setManagerEditValue(safeGetCellValueAsString(record, table, clientsFieldId));
    };

    const saveClientEdit = async (record) => {
        if (!clientsFieldId || !table) return;
        if (!fieldExistsInTable(table, clientsFieldId)) {
            alert("Clients field not found in this table.");
            return;
        }
        setManagerSaving(true);
        try {
            await table.updateRecordAsync(record, { [clientsFieldId]: managerEditValue });
            setManagerEditingId(null);
        } catch (err) {
            console.error("Failed to save client edit:", err);
            alert("Save failed: " + err.message);
        }
        setManagerSaving(false);
    };

    const handleSearchJump = (name) => {
        setSearchName(name);
        if (!name) return;
        const index = filteredRecords.findIndex(r => (r.name || '').toLowerCase().includes(name.toLowerCase()));
        if (index !== -1) {
            setRecordIndex(index);
        }
    };

    // LOAD FONTS — build the Google Fonts request from FONT_CATALOG so every option
    // in the pickers is actually available (the old loader only fetched 3 of them,
    // so picking any other font silently fell back to a system face in the PDF).
    useEffect(() => {
        const families = FONT_CATALOG.filter(f => f.google).map(f => 'family=' + f.google).join('&');
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
        document.head.appendChild(link);
        return () => { try { document.head.removeChild(link); } catch (e) { /* ignore */ } };
    }, []);

    const pageRef = useRef(null);
    const fileInputRef = useRef(null);
    const iconInputRef = useRef(null); 
    const staticImageInputRef = useRef(null);
    // FIX (crash on click): react-draggable v4 without a nodeRef falls back to the
    // deprecated ReactDOM.findDOMNode. In the released-block iframe that lookup can
    // resolve to null, and react-draggable then reads `.parentNode`/offsets off null
    // on drag-start — which fires on the mousedown of ANY click on a canvas element
    // (made worse by bounds="parent"). Giving each Draggable its own ref removes the
    // findDOMNode path entirely. We keep one stable ref per element id.
    const nodeRefs = useRef({});
    const getNodeRef = (id) => {
        if (!nodeRefs.current[id]) nodeRefs.current[id] = React.createRef();
        return nodeRefs.current[id];
    };

    // 3. ACTIONS
    const historyRef = useRef({ past: [], future: [] });
    const [historyTick, setHistoryTick] = useState(0);

    const updateElements = (newElements) => {
        // Record the pre-change snapshot for undo. Elements only (page background,
        // fonts, and the roster filter are tracked separately and aren't part of
        // this history). Bounded so it can't grow without limit.
        const h = historyRef.current;
        h.past.push(JSON.stringify(elements));
        if (h.past.length > 60) h.past.shift();
        h.future = [];
        setHistoryTick(t => t + 1);
        // A too-large value (usually an oversized image) makes globalConfig reject —
        // and historically that surfaced as a white screen. Catch both the async
        // rejection and any synchronous throw so a bad write never crashes the editor.
        try {
            const p = globalConfig.setAsync(elementsKey, newElements);
            if (p && typeof p.catch === 'function') {
                p.catch(err => {
                    console.warn("Could not save layout (too large?)", err);
                    alert("Couldn't save that change. The layout may be too large — usually an oversized image. Try a smaller image.");
                });
            }
        } catch (err) {
            console.warn("Could not save layout (too large?)", err);
            alert("Couldn't save that change. The layout may be too large — usually an oversized image. Try a smaller image.");
        }
    };

    const undo = () => {
        const h = historyRef.current;
        if (h.past.length === 0) return;
        const prev = h.past.pop();
        h.future.push(JSON.stringify(elements));
        setHistoryTick(t => t + 1);
        globalConfig.setAsync(elementsKey, JSON.parse(prev));
        setSelectedElementId(null); setSelectedChildPath([]); setSelectedIds([]);
    };

    const redo = () => {
        const h = historyRef.current;
        if (h.future.length === 0) return;
        const next = h.future.pop();
        h.past.push(JSON.stringify(elements));
        setHistoryTick(t => t + 1);
        globalConfig.setAsync(elementsKey, JSON.parse(next));
        setSelectedElementId(null); setSelectedChildPath([]); setSelectedIds([]);
    };

    // Keep refs to the latest undo/redo so a once-attached key listener never goes stale.
    const undoRef = useRef(undo); undoRef.current = undo;
    const redoRef = useRef(redo); redoRef.current = redo;
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            const tag = t && t.tagName;
            const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
            if (typing) return;
            if (!(e.metaKey || e.ctrlKey)) return;
            const k = (e.key || '').toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRef.current(); }
            else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoRef.current(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const updatePageStyle = async (updates) => {
        const newStyle = { ...pageStyle, ...updates };
        try {
            await globalConfig.setAsync(pageStyleKey, newStyle);
        } catch (err) {
            console.warn("Could not save to globalConfig", err);
            if (updates.imageUrl) {
                alert("Image too large. Using for this session only.");
                setSessionImage(updates.imageUrl);
            }
        }
    };

    const setTitlePageEnabled = async (val) => {
        try { await globalConfig.setAsync('titlePageEnabled', !!val); }
        catch (err) { console.warn("Could not save title-page toggle", err); }
    };

    // Switch the editor between the roster card and the standalone title page. The
    // title page is initialized (once) from the current roster page so its dimensions
    // match. History is per-mode, so it's reset on switch to avoid cross-contamination.
    const switchMode = async (mode) => {
        if (mode === 'title') {
            try {
                if (!globalConfig.get('titlePageStyle')) {
                    // Match the roster page's size + base font, but start with a clean solid
                    // background so we don't duplicate the roster's heavy baked image into
                    // globalConfig (which could blow the size limit). User sets bg in the panel.
                    const base = globalConfig.get('pageStyle') || {};
                    await globalConfig.setAsync('titlePageStyle', {
                        ...DEFAULT_PAGE_STYLE,
                        type: 'solid',
                        width: base.width || DEFAULT_PAGE_WIDTH,
                        height: base.height || DEFAULT_PAGE_HEIGHT,
                        fontFamily: base.fontFamily || DEFAULT_ELEMENT_STYLE.fontFamily
                    });
                }
                if (!Array.isArray(globalConfig.get('titleElements'))) await globalConfig.setAsync('titleElements', []);
                if (globalConfig.get('titlePageEnabled') === undefined) await globalConfig.setAsync('titlePageEnabled', true);
            } catch (err) { console.warn("Could not initialize title page", err); }
        }
        historyRef.current = { past: [], future: [] };
        setHistoryTick(t => t + 1);
        setSelectedElementId(null); setSelectedChildPath([]); setSelectedIds([]);
        setDesignMode(mode);
    };

    // Set the font on every element (and every stack child) at once — the fast way
    // to try a whole-card look. Leaves all other styling untouched.
    const applyFontToAll = (font) => {
        const f = font || DEFAULT_ELEMENT_STYLE.fontFamily;
        const newElements = elements.map(el => {
            const updated = { ...el, style: { ...el.style, fontFamily: f } };
            if (Array.isArray(el.children) && el.children.length > 0) {
                updated.children = el.children.map(c => ({ ...c, style: { ...c.style, fontFamily: f } }));
            }
            return updated;
        });
        updateElements(newElements);
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (f) => {
                // Downscale so a full-res photo doesn't overflow globalConfig.
                const scaled = await downscaleImageDataUrl(f.target.result, 1600, 0.85);
                updatePageStyle({ type: 'image', imageUrl: scaled });
            };
            reader.readAsDataURL(file);
        }
    };

    const handleIconUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (f) => {
                if (selectedElementId) {
                    updateSelected({ customIcon: f.target.result });
                }
            };
            reader.readAsDataURL(file);
        }
    };

    const handleAlign = (alignment) => {
        if (!selectedElementId) return;
        const el = elements.find(e => e.id === selectedElementId);
        if (!el) return;

        let newX = el.x;
        let newY = el.y;
        const w = el.width || 200;
        const h = el.height || 40;
        const pW = pageStyle.width || DEFAULT_PAGE_WIDTH;
        const pH = pageStyle.height || DEFAULT_PAGE_HEIGHT;

        switch(alignment) {
            case 'left': newX = 50; break; 
            case 'center': newX = (pW - w) / 2; break;
            case 'right': newX = pW - w - 50; break;
            case 'top': newY = 50; break;
            case 'middle': newY = (pH - h) / 2; break;
            case 'bottom': newY = pH - h - 50; break;
        }
        updateElementPosition(el.id, newX, newY);
    };

    // Helper to create uniform element structure
    const createLayer = (type, fieldId = null) => {
        const isStack = type === 'stack';
        return {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: type, 
            displayMode: 'text', 
            iconType: 'link', 
            fieldId: fieldId,
            text: type === 'static' ? 'New Text' : '',
            x: 50,
            y: 50,
            width: isStack ? 400 : (type === 'field' ? 200 : 200),
            height: isStack ? 80 : (type === 'field' ? 40 : 40),
            // Stack Properties (only used if type is stack)
            stackDirection: 'row',
            stackSpacing: 10,
            stackAlign: 'flex-start',
            children: [],
            style: { 
                ...DEFAULT_ELEMENT_STYLE,
                // New elements inherit the page's base font (if one is set) so the
                // card stays typographically consistent as you add to it.
                fontFamily: pageStyle.fontFamily || DEFAULT_ELEMENT_STYLE.fontFamily,
                // Default stack background is transparent, no border
                borderWidth: isStack ? '1px' : '0px',
                borderColor: isStack ? '#cccccc' : 'transparent',
                borderStyle: isStack ? 'dashed' : 'solid'
            }
        };
    };

    const addElement = (type, fieldId = null) => {
        const newElement = createLayer(type, fieldId);
        updateElements([...elements, newElement]);
        setSelectedElementId(newElement.id);
        setSelectedIds([newElement.id]);
        setEditMode('elements');
    };

    const createStackChild = (itemType) => {
        if (itemType === 'stack') {
            const s = createLayer('stack');
            s.width = 200; s.height = 100;
            s.children = [];
            return s;
        }
        let newItemType = 'field', newItemDisplayMode = 'text';
        if (itemType === 'static') { newItemType = 'static'; newItemDisplayMode = 'text'; }
        else if (itemType === 'field') { newItemType = 'field'; newItemDisplayMode = 'text'; }
        else if (itemType === 'icon') { newItemType = 'field'; newItemDisplayMode = 'icon'; }
        else if (itemType === 'image') { newItemType = 'field'; newItemDisplayMode = 'image'; }
        const newItem = createLayer(newItemType);
        newItem.displayMode = newItemDisplayMode;
        if (itemType === 'icon') { newItem.width = 40; newItem.height = 40; }
        else if (itemType === 'image') { newItem.width = 60; newItem.height = 60; }
        return newItem;
    };

    // Add an item to the currently-selected stack (root OR a nested stack at the path).
    const addStackItem = (itemType) => {
        if (!selectedElementId) return;
        const root = elements.find(el => el.id === selectedElementId);
        const target = getChildByPath(root, selectedChildPath);
        if (!target || target.type !== 'stack') return;
        const newItem = createStackChild(itemType);
        const newElements = elements.map(el => el.id === selectedElementId
            ? updateChildByPath(el, selectedChildPath, (stack) => ({ ...stack, children: [...(stack.children || []), newItem] }))
            : el);
        updateElements(newElements);
    };

    // Remove a child at parentPath's list. parentPath addresses the containing stack.
    const removeStackItem = (parentPath, childId) => {
        if (!selectedElementId) return;
        const newElements = elements.map(el => el.id === selectedElementId
            ? updateChildByPath(el, parentPath, (parent) => ({ ...parent, children: (parent.children || []).filter(c => c.id !== childId) }))
            : el);
        updateElements(newElements);
        // If the selected item was inside what we removed, step selection back up.
        if (selectedChildPath.length > parentPath.length && selectedChildPath[parentPath.length] === childId) {
            setSelectedChildPath(parentPath);
        }
    };

    // Reorder a child within its parent stack (parentPath). dir = -1 / +1.
    const moveStackItem = (parentPath, childId, dir) => {
        if (!selectedElementId) return;
        const newElements = elements.map(el => el.id === selectedElementId
            ? updateChildByPath(el, parentPath, (parent) => {
                const children = [...(parent.children || [])];
                const i = children.findIndex(c => c.id === childId);
                const j = i + dir;
                if (i === -1 || j < 0 || j >= children.length) return parent;
                [children[i], children[j]] = [children[j], children[i]];
                return { ...parent, children };
            })
            : el);
        updateElements(newElements);
    };

    // Move the currently-selected nested item back out to a top-level element.
    const popOutOfStack = () => {
        if (!selectedChildPath.length) return;
        const root = elements.find(el => el.id === selectedElementId);
        const node = getChildByPath(root, selectedChildPath);
        if (!root || !node) return;
        const popped = { ...node, x: (root.x || 50) + 24, y: (root.y || 50) + 24, width: node.width || 120, height: node.height || 40 };
        const trimmedRoot = removeChildByPath(root, selectedChildPath);
        const newElements = elements.map(el => el.id === selectedElementId ? trimmedRoot : el).concat(popped);
        updateElements(newElements);
        setSelectedElementId(popped.id);
        setSelectedChildPath([]);
        setSelectedIds([popped.id]);
    };

    // Drag-drop reparent: move a top-level element into a stack's items. Dropping a
    // stack into a stack nests it. x/y are dropped (flex positions them instead).
    const reparentIntoStack = (elId, stackId) => {
        const dragged = elements.find(e => e.id === elId);
        const target = elements.find(e => e.id === stackId);
        if (!dragged || !target || target.type !== 'stack' || elId === stackId) return;
        const child = { ...dragged, width: dragged.width || 120, height: dragged.height || 40 };
        delete child.x; delete child.y;
        // Grow the target so the dropped item fits (an empty stack is small and would
        // otherwise clip a larger stack dropped into it — its items wouldn't show).
        const pad = 16;
        const grownW = Math.max(target.width || 0, (child.width || 0) + pad);
        const grownH = Math.max(target.height || 0, (child.height || 0) + pad);
        const newElements = elements
            .filter(e => e.id !== elId)
            .map(e => e.id === stackId
                ? { ...e, width: grownW, height: grownH, children: [...(e.children || []), child] }
                : e);
        updateElements(newElements);
        setSelectedElementId(stackId);
        setSelectedChildPath([child.id]);
        setSelectedIds([stackId]);
    };

    const addShape = (shapeType) => {
        const isLine = shapeType === 'line';
        const newElement = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: 'shape', 
            shapeType: shapeType, 
            x: 50, y: 50,
            width: isLine ? 200 : 100,
            height: isLine ? 1 : 100,        // line height == thickness (1px default)
            style: { 
                ...DEFAULT_ELEMENT_STYLE,
                padding: '0px',              // lines/shapes shouldn't carry text padding
                backgroundColor: isLine ? '#000000' : '#cccccc',
                borderWidth: '0px',
                borderColor: '#000000'
            }
        };
        updateElements([...elements, newElement]);
        setSelectedElementId(newElement.id);
        setSelectedIds([newElement.id]);
        setEditMode('elements');
    };

    // Static (uploaded) image element — not tied to a record field.
    const addStaticImage = () => {
        const newElement = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: 'static',
            displayMode: 'image',
            staticImage: null,
            x: 50, y: 50, width: 220, height: 160,
            style: { ...DEFAULT_ELEMENT_STYLE, padding: '0px', backgroundColor: 'transparent', borderWidth: '0px', borderColor: 'transparent' }
        };
        updateElements([...elements, newElement]);
        setSelectedElementId(newElement.id);
        setSelectedIds([newElement.id]);
        setEditMode('elements');
        // Open the file picker right away.
        setTimeout(() => { if (staticImageInputRef.current) staticImageInputRef.current.click(); }, 60);
    };

    // Downscale + store an uploaded image on the selected element (keeps globalConfig
    // size sane — full-res data URLs can be multiple MB). Encodes as PNG when the
    // element is flagged transparent (or the source file is a PNG and no choice was
    // made yet), so transparent images keep their alpha instead of flattening to black.
    // Commit an image onto the selected element with a guarded, awaitable write.
    // Returns true on success, false if globalConfig rejected it (too large) — so the
    // caller can shrink and retry or surface a clear message instead of crashing.
    const trySetStaticImage = async (dataUrl, wantPng) => {
        const id = selectedElementId;
        if (!id) return false;
        const newElements = elements.map(el => el.id === id ? { ...el, staticImage: dataUrl, transparentPng: wantPng } : el);
        const prev = JSON.stringify(elements);
        try {
            await globalConfig.setAsync(elementsKey, newElements);
            const h = historyRef.current;
            h.past.push(prev);
            if (h.past.length > 60) h.past.shift();
            h.future = [];
            setHistoryTick(t => t + 1);
            return true;
        } catch (err) {
            console.warn("Image write rejected (too large?)", err);
            return false;
        }
    };

    const handleStaticImageUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const sel = elements.find(el => el.id === selectedElementId);
        const wantPng = (sel && typeof sel.transparentPng === 'boolean')
            ? sel.transparentPng
            : (file.type === 'image/png');
        const reader = new FileReader();
        reader.onload = (f) => {
            const img = new Image();
            img.onload = async () => {
                // Encode at a given max dimension, keeping the chosen format.
                const encodeAt = (MAX) => {
                    let w = img.width, h = img.height;
                    if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
                    else { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    return wantPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
                };
                // Try progressively smaller versions until globalConfig accepts one.
                // This both prevents the oversized-write crash and keeps the image as
                // large as will actually fit.
                const sizes = [1200, 900, 700, 500];
                let lastUrl = '';
                for (const s of sizes) {
                    lastUrl = encodeAt(s);
                    if (await trySetStaticImage(lastUrl, wantPng)) return;
                }
                alert(
                    `This image is too large to store (about ${formatBytes(dataUrlBytes(lastUrl))} even after shrinking). ` +
                    `Use a smaller or lower-resolution image${wantPng ? ', or turn off Transparent (PNG) to store a lighter JPEG.' : '.'}`
                );
            };
            img.onerror = () => alert("Couldn't read that image file. Try a different file.");
            img.src = f.target.result;
        };
        reader.readAsDataURL(file);
        e.target.value = ''; // allow re-uploading the same file
    };

    // Re-encode the already-stored static image to the chosen format when the toggle
    // flips. Note: alpha can't be recovered from an image already saved as JPEG — to
    // get real transparency, turn this on and re-upload the source PNG.
    const reencodeStaticImage = (el, toPng) => {
        if (!el || !el.staticImage) { updateSelected({ transparentPng: toPng }); return; }
        const img = new Image();
        img.onload = async () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            const dataUrl = toPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
            const ok = await trySetStaticImage(dataUrl, toPng);
            if (!ok) {
                alert(
                    `Switching to ${toPng ? 'PNG' : 'JPEG'} makes this image too large to store (about ${formatBytes(dataUrlBytes(dataUrl))}). ` +
                    `Keeping the current version. Re-upload a smaller image if you need ${toPng ? 'transparency' : 'this format'}.`
                );
            }
        };
        img.onerror = () => updateSelected({ transparentPng: toPng });
        img.src = el.staticImage;
    };

    // ── MULTI-SELECT ORGANIZE ──────────────────────────────────────────────
    const getSelectedElements = () => elements.filter(e => selectedIds.includes(e.id));

    // Align the selected elements to one another (relative to the group's bounds),
    // not to the page.
    const alignSelected = (mode) => {
        const sel = getSelectedElements();
        if (sel.length < 2) return;
        const minL = Math.min(...sel.map(e => e.x));
        const maxR = Math.max(...sel.map(e => e.x + (e.width || 0)));
        const minT = Math.min(...sel.map(e => e.y));
        const maxB = Math.max(...sel.map(e => e.y + (e.height || 0)));
        const cx = (minL + maxR) / 2, cy = (minT + maxB) / 2;
        const map = {};
        sel.forEach(e => {
            const w = e.width || 0, h = e.height || 0;
            let nx = e.x, ny = e.y;
            if (mode === 'left') nx = minL;
            else if (mode === 'right') nx = maxR - w;
            else if (mode === 'hcenter') nx = cx - w / 2;
            else if (mode === 'top') ny = minT;
            else if (mode === 'bottom') ny = maxB - h;
            else if (mode === 'vcenter') ny = cy - h / 2;
            map[e.id] = { x: nx, y: ny };
        });
        updateElements(elements.map(e => map[e.id] ? { ...e, ...map[e.id] } : e));
    };

    // Even spacing between centers, along an axis (needs 3+).
    const distributeSelected = (axis) => {
        const sel = getSelectedElements();
        if (sel.length < 3) return;
        const sorted = [...sel].sort((a, b) => axis === 'h' ? a.x - b.x : a.y - b.y);
        const centerOf = (e) => axis === 'h' ? e.x + (e.width || 0) / 2 : e.y + (e.height || 0) / 2;
        const startC = centerOf(sorted[0]);
        const endC = centerOf(sorted[sorted.length - 1]);
        const step = (endC - startC) / (sorted.length - 1);
        const map = {};
        sorted.forEach((e, i) => {
            const c = startC + step * i;
            map[e.id] = axis === 'h'
                ? { x: c - (e.width || 0) / 2, y: e.y }
                : { x: e.x, y: c - (e.height || 0) / 2 };
        });
        updateElements(elements.map(e => map[e.id] ? { ...e, ...map[e.id] } : e));
    };

    // ── SELECTION ACTIONS (used by buttons + keyboard shortcuts) ────────────
    const genId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);

    const deleteSelected = () => {
        if (selectedChildPath.length) {
            removeStackItem(selectedChildPath.slice(0, -1), selectedChildPath[selectedChildPath.length - 1]);
            return;
        }
        if (selectedIds.length === 0) return;
        const ids = new Set(selectedIds);
        updateElements(elements.filter(e => !ids.has(e.id)));
        setSelectedElementId(null);
        setSelectedIds([]);
    };

    const duplicateSelected = () => {
        if (selectedStackChildId || selectedIds.length === 0) return; // top-level only
        const regenIds = (node) => {
            const copy = { ...node, id: genId() };
            if (Array.isArray(node.children)) copy.children = node.children.map(regenIds);
            return copy;
        };
        const ids = new Set(selectedIds);
        const copies = [];
        elements.forEach(e => {
            if (!ids.has(e.id)) return;
            const copy = regenIds(JSON.parse(JSON.stringify(e)));
            copy.x = (e.x || 0) + 12;
            copy.y = (e.y || 0) + 12;
            copies.push(copy);
        });
        if (copies.length === 0) return;
        updateElements([...elements, ...copies]);
        const newIds = copies.map(c => c.id);
        setSelectedIds(newIds);
        setSelectedElementId(newIds[newIds.length - 1]);
    };

    const nudgeSelected = (dx, dy) => {
        if (selectedIds.length === 0) return;
        const ids = new Set(selectedIds);
        updateElements(elements.map(e => ids.has(e.id) ? { ...e, x: (e.x || 0) + dx, y: (e.y || 0) + dy } : e));
    };

    const deselectAll = () => {
        setSelectedElementId(null);
        setSelectedChildPath([]);
        setSelectedIds([]);
    };

    // Keyboard shortcuts (kept fresh via a ref so the once-attached listener never
    // closes over stale selection/elements). Ignored while typing in a field.
    const shortcutsRef = useRef(null);
    shortcutsRef.current = (e) => {
        const t = e.target;
        const tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        const hasSel = selectedIds.length > 0 || !!selectedStackChildId;
        const key = e.key || '';
        if (key === 'Delete' || key === 'Backspace') {
            if (hasSel) { e.preventDefault(); deleteSelected(); }
        } else if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === 'd') {
            e.preventDefault(); duplicateSelected();
        } else if (key === 'Escape') {
            deselectAll();
        } else if (key.indexOf('Arrow') === 0) {
            if (!hasSel || selectedStackChildId) return; // stack children are flex-positioned
            const step = e.shiftKey ? 10 : 1;
            let dx = 0, dy = 0;
            if (key === 'ArrowLeft') dx = -step;
            else if (key === 'ArrowRight') dx = step;
            else if (key === 'ArrowUp') dy = -step;
            else if (key === 'ArrowDown') dy = step;
            if (dx || dy) { e.preventDefault(); nudgeSelected(dx, dy); }
        }
    };
    useEffect(() => {
        const onKey = (e) => { if (shortcutsRef.current) shortcutsRef.current(e); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const updateSelected = (updates) => {
        if (!selectedElementId) return;
        const applyMerge = (node) => {
            if (updates.style) return { ...node, ...updates, style: { ...node.style, ...updates.style } };
            return { ...node, ...updates };
        };
        const newElements = elements.map(el => el.id === selectedElementId
            ? updateChildByPath(el, selectedChildPath, applyMerge)
            : el);
        updateElements(newElements);
    };

    const updateSelectedStyle = (property, value) => {
        if (!selectedElementId) return;
        const applyStyle = (node) => ({ ...node, style: { ...node.style, [property]: value } });
        const newElements = elements.map(el => el.id === selectedElementId
            ? updateChildByPath(el, selectedChildPath, applyStyle)
            : el);
        updateElements(newElements);
    };

    const updateElementPosition = (id, x, y) => {
        const newElements = elements.map(el => {
            if (el.id === id) return { ...el, x, y };
            return el;
        });
        updateElements(newElements);
    };

    const deleteElement = (id) => {
        const newElements = elements.filter(el => el.id !== id);
        updateElements(newElements);
        setSelectedElementId(null);
        setSelectedIds([]);
    };
    
    const resetCanvas = () => {
        if(confirm("Are you sure you want to delete all elements?")) {
            updateElements([]);
            setSelectedElementId(null);
        }
    }



    // =========================================================================
    // TEMPLATE SAVE & EXPORT
    // =========================================================================

    // Saves the current layout to globalConfig as the new default.
    // Any future first-run install in this workspace will load this instead
    // of the static template.json file.
    const saveAsDefaultTemplate = async () => {
        if (!confirm("Save the current layout as the default template?\n\nThis will be used as the starting point for any new install of this block in your workspace.")) return;
        try {
            // Always the roster card, even if the title-page editor is open.
            const rosterElements = Array.isArray(globalConfig.get('elements')) ? globalConfig.get('elements') : [];
            const rosterPageStyle = globalConfig.get('pageStyle') ? { ...DEFAULT_PAGE_STYLE, ...globalConfig.get('pageStyle') } : DEFAULT_PAGE_STYLE;
            await globalConfig.setAsync('defaultTemplate', {
                elements: rosterElements,
                pageStyle: rosterPageStyle
            });
            alert("Default template saved!\n\nNew installs of this block will start with this layout.");
        } catch (err) {
            console.error("Failed to save default template:", err);
            alert("Failed to save. Make sure you have creator permissions.");
        }
    };

    // Downloads the current layout as a template.json file.
    // Drop this file into your project root and redeploy to bake it
    // into the bundle as the permanent static fallback.
    const exportTemplateJSON = () => {
        const rosterElements = Array.isArray(globalConfig.get('elements')) ? globalConfig.get('elements') : [];
        const rosterPageStyle = globalConfig.get('pageStyle') ? { ...DEFAULT_PAGE_STYLE, ...globalConfig.get('pageStyle') } : DEFAULT_PAGE_STYLE;
        const snapshot = { elements: rosterElements, pageStyle: rosterPageStyle };
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'template.json';
        a.click();
        URL.revokeObjectURL(url);
    };

    // Restores the live defaultTemplate from globalConfig (if one exists),
    // falling back to the static template.json file.
    const loadDefaultTemplate = async () => {
        const savedDefault = globalConfig.get('defaultTemplate');
        const source = savedDefault || templateData;
        if (!source) {
            alert("No default template found.");
            return;
        }
        if (!confirm(`Load ${savedDefault ? 'saved default template' : 'template.json'}? This will replace your current layout.`)) return;
        try {
            if (source.elements) {
                await globalConfig.setAsync(
                    'elements',
                    validateTemplateElements(source.elements, table)
                );
            }
            if (source.pageStyle) {
                await globalConfig.setAsync('pageStyle', source.pageStyle);
            }
            const hadUnknownFields = (source.elements || []).some(el =>
                (el.fieldId && !table?.getFieldByIdIfExists(el.fieldId)) ||
                (el.children || []).some(c => c.fieldId && !table?.getFieldByIdIfExists(c.fieldId))
            );
            alert(hadUnknownFields
                ? "Template loaded! Some field bindings were cleared (they were from a different base). Re-map them in the sidebar."
                : "Template loaded successfully!"
            );
        } catch (err) {
            console.error("Failed to load template:", err);
            alert("Make sure you have creator permissions.");
        }
    };

    // =========================================================================
    // 4. SMART DRAG & SNAP ENGINE
    // =========================================================================
    
    const calculateSnap = (id, x, y) => {
        const el = elements.find(e => e.id === id);
        if (!el) return { x, y, activeGuides: [] };

        const w = el.width || 200;
        const h = el.height || 40;
        
        const targetsX = [
            { val: pageStyle.width / 2, type: 'center' },
            { val: 50, type: 'margin' },
            { val: pageStyle.width - 50, type: 'margin' }
        ];
        const targetsY = [
            { val: pageStyle.height / 2, type: 'center' },
            { val: 50, type: 'margin' },
            { val: pageStyle.height - 50, type: 'margin' }
        ];

        elements.forEach(other => {
            if (other.id === id) return;
            const ow = other.width || 200;
            const oh = other.height || 40;
            targetsX.push({ val: other.x, type: 'edge' });
            targetsX.push({ val: other.x + ow / 2, type: 'center' });
            targetsX.push({ val: other.x + ow, type: 'edge' });
            
            targetsY.push({ val: other.y, type: 'edge' });
            targetsY.push({ val: other.y + oh / 2, type: 'center' });
            targetsY.push({ val: other.y + oh, type: 'edge' });
        });

        const myEdgesX = [x, x + w / 2, x + w];
        const myEdgesY = [y, y + h / 2, y + h];

        let newX = x;
        let newY = y;
        const activeGuides = [];

        let snappedX = false;
        for (let edge of myEdgesX) {
            if (snappedX) break;
            for (let target of targetsX) {
                if (Math.abs(edge - target.val) < SNAP_THRESHOLD) {
                    const delta = target.val - edge;
                    newX += delta;
                    activeGuides.push({ type: 'vertical', pos: target.val });
                    snappedX = true; 
                    break;
                }
            }
        }

        let snappedY = false;
        for (let edge of myEdgesY) {
            if (snappedY) break;
            for (let target of targetsY) {
                if (Math.abs(edge - target.val) < SNAP_THRESHOLD) {
                    const delta = target.val - edge;
                    newY += delta;
                    activeGuides.push({ type: 'horizontal', pos: target.val });
                    snappedY = true;
                    break;
                }
            }
        }

        return { x: newX, y: newY, activeGuides };
    };

    // On drag start, if the grabbed element is part of a multi-selection, snapshot
    // every selected element's start position so the whole group moves together.
    const handleDragStart = (e, data, id) => {
        if (selectedIds.length > 1 && selectedIds.includes(id)) {
            const positions = {};
            elements.forEach(el => { if (selectedIds.includes(el.id)) positions[el.id] = { x: el.x, y: el.y }; });
            groupStartRef.current = { anchorId: id, anchor: { x: data.x, y: data.y }, positions };
        } else {
            groupStartRef.current = null;
        }
    };

    // The top-level stack that best overlaps the dragged element's box, for drag-to-add.
    // Overlap (not center-in-target) so a large stack dropped onto a small/empty stack
    // still registers. Requires meaningful coverage so passing over doesn't false-trigger.
    const findStackDropTarget = (draggedId, box) => {
        const draggedArea = Math.max(1, (box.w || 0) * (box.h || 0));
        let best = null, bestRatio = 0;
        for (const el of elements) {
            if (el.type !== 'stack' || el.id === draggedId) continue;
            const ew = el.width || 0, eh = el.height || 0;
            const ix = Math.max(box.x, el.x);
            const iy = Math.max(box.y, el.y);
            const iw = Math.min(box.x + box.w, el.x + ew) - ix;
            const ih = Math.min(box.y + box.h, el.y + eh) - iy;
            if (iw <= 0 || ih <= 0) continue;
            const overlap = iw * ih;
            const ratio = overlap / Math.min(draggedArea, Math.max(1, ew * eh));
            if (ratio > bestRatio) { bestRatio = ratio; best = el; }
        }
        return bestRatio >= 0.35 ? best : null; // needs ~a third of the smaller box covered
    };

    const handleDrag = (e, data, id) => {
        const g = groupStartRef.current;
        if (g && g.anchorId === id) {
            const dx = data.x - g.anchor.x;
            const dy = data.y - g.anchor.y;
            const moved = {};
            Object.keys(g.positions).forEach(eid => {
                moved[eid] = { x: g.positions[eid].x + dx, y: g.positions[eid].y + dy };
            });
            setGroupDrag(moved);
            setGuides([]); // snapping is per-element; skip it during a group move
            setDropTargetStackId(null);
            return;
        }
        const { x, y, activeGuides } = calculateSnap(id, data.x, data.y);
        setDraggingState({ id, x, y });
        setGuides(activeGuides);
        // Live highlight of the stack this would drop into.
        const dragged = elements.find(el => el.id === id);
        if (dragged) {
            const t = findStackDropTarget(id, { x, y, w: dragged.width || 0, h: dragged.height || 0 });
            setDropTargetStackId(t ? t.id : null);
        }
    };

    const handleDragStop = (e, data, id) => {
        const g = groupStartRef.current;
        if (g && g.anchorId === id) {
            const dx = data.x - g.anchor.x;
            const dy = data.y - g.anchor.y;
            const newElements = elements.map(el => (
                g.positions[el.id] ? { ...el, x: g.positions[el.id].x + dx, y: g.positions[el.id].y + dy } : el
            ));
            updateElements(newElements);
            groupStartRef.current = null;
            setGroupDrag(null);
            setGuides([]);
            setDropTargetStackId(null);
            return;
        }
        const { x, y } = calculateSnap(id, data.x, data.y);
        // Drag-to-add: if this element's center is dropped over a (different) top-level
        // stack, move it into that stack's items instead of just repositioning.
        const dragged = elements.find(el => el.id === id);
        if (dragged) {
            const target = findStackDropTarget(id, { x, y, w: dragged.width || 0, h: dragged.height || 0 });
            if (target) {
                reparentIntoStack(id, target.id);
                setDraggingState(null);
                setGuides([]);
                setDropTargetStackId(null);
                return;
            }
        }
        updateElementPosition(id, x, y);
        setDraggingState(null);
        setGuides([]);
        setDropTargetStackId(null);
    };

    // --- RESIZE ENGINE ---
    useEffect(() => {
        if (!resizingState) return;

        const handleMouseMove = (e) => {
            const deltaX = e.clientX - resizingState.startX;
            const deltaY = e.clientY - resizingState.startY;
            
            setResizingState(prev => ({
                ...prev,
                currentW: Math.max(0.1, prev.startW + deltaX),
                currentH: Math.max(0.1, prev.startH + deltaY)
            }));
        };

        const handleMouseUp = () => {
            if (resizingState) {
                const newElements = elements.map(el => {
                    if (el.id === resizingState.id) {
                        return { ...el, width: resizingState.currentW, height: resizingState.currentH };
                    }
                    return el;
                });
                updateElements(newElements);
                setResizingState(null);
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [resizingState, elements]);

    const startResizing = (e, id, currentW, currentH) => {
        e.stopPropagation(); 
        e.preventDefault(); 
        setResizingState({
            id,
            startX: e.clientX,
            startY: e.clientY,
            startW: currentW,
            startH: currentH,
            currentW: currentW,
            currentH: currentH
        });
    };

    // 5. PRE-PROCESSOR FOR IMAGES (Fixes CORS/Missing Images)
    // FIX: Use refs to avoid stale closures — the function captures the latest
    // elements and imageCache without needing to be recreated on every render.
    const elementsRef = useRef(elements);
    const imageCacheRef = useRef(imageCache);
    const blurCacheRef = useRef(blurCache);
    useEffect(() => { elementsRef.current = elements; }, [elements]);
    useEffect(() => { imageCacheRef.current = imageCache; }, [imageCache]);
    useEffect(() => { blurCacheRef.current = blurCache; }, [blurCache]);

    // Blur-fill targets for a record: { key, base64 } pairs. Field images key by
    // attachment URL (base64 only once cached); static images key by element id and
    // carry their own data URL.
    const blurTargetsForRecord = (record, cacheOverride) => {
        const cache = cacheOverride || imageCacheRef.current;
        const targets = [];
        const collect = (el) => {
            if (el.displayMode === 'image' && el.blurFill) {
                if (el.type === 'field' && record && el.fieldId) {
                    const raw = safeGetCellValue(record, table, el.fieldId);
                    const u = (Array.isArray(raw) && raw[0] && raw[0].url) ? raw[0].url : null;
                    if (u && cache[u]) targets.push({ key: u, base64: cache[u] });
                } else if (el.staticImage) {
                    targets.push({ key: 'static:' + el.id, base64: el.staticImage });
                }
            }
            if (el.type === 'stack' && el.children) el.children.forEach(collect);
        };
        (elementsRef.current || []).forEach(collect);
        return targets;
    };

    // Generate any missing blurred variants for the given targets. Commits once.
    const ensureBlurForTargets = async (targets) => {
        const blurs = blurCacheRef.current;
        const seen = new Set();
        const todo = [];
        for (const t of targets) {
            if (!t || !t.key || !t.base64 || blurs[t.key] || seen.has(t.key)) continue;
            seen.add(t.key);
            todo.push(t);
        }
        if (todo.length === 0) return;
        const updates = {};
        for (const t of todo) {
            const b = await generateBlurredDataUrl(t.base64);
            if (b) updates[t.key] = b;
        }
        if (Object.keys(updates).length > 0) {
            setBlurCache(prev => ({ ...prev, ...updates }));
        }
    };

    const prepareRecordForPrint = async (record) => {
        const cacheUpdates = {};
        const currentElements = elementsRef.current;
        const currentCache = imageCacheRef.current;
        
        const processElement = async (el) => {
            if (el.type === 'field' && record && el.fieldId) { 
                try {
                    // FIX: Use safe wrapper — fieldId may be stale or from another base
                    const rawValue = safeGetCellValue(record, table, el.fieldId);
                    if (Array.isArray(rawValue) && rawValue[0] && rawValue[0].url) {
                        const url = rawValue[0].url;
                        if (!currentCache[url] && !cacheUpdates[url]) {
                            const base64 = await fetchImageAsBase64(url);
                            if (base64) cacheUpdates[url] = base64;
                        }
                    }
                } catch (err) {
                    console.warn(`Could not fetch value for field ${el.fieldId}`, err);
                }
            }
            // Recurse for stack
            if (el.type === 'stack' && el.children) {
                for (const child of el.children) {
                    await processElement(child);
                }
            }
        };

        const tasks = currentElements.map(el => processElement(el));
        await Promise.all(tasks);
        if (Object.keys(cacheUpdates).length > 0) {
            setImageCache(prev => ({ ...prev, ...cacheUpdates }));
        }
    };

    // Load images immediately when the current record changes
    useEffect(() => {
        if (currentRecord) {
            prepareRecordForPrint(currentRecord);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentRecord?.id]); // Depend on ID only — stable reference

    // Generate the blurred backdrop(s) for the current record's blur-fill images,
    // once their base64 is cached. Re-runs when the record, the cache, or the
    // layout (e.g. toggling blur-fill on) changes.
    useEffect(() => {
        if (currentRecord) {
            ensureBlurForTargets(blurTargetsForRecord(currentRecord));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentRecord?.id, imageCache, elements]);

    // 6. PDF GENERATION
    // Capture resolution multiplier. Higher = crisper output (text, raster images,
    // and rasterized vectors), at the cost of memory/time. cropCanvas MUST use the
    // same value or the crop will be misaligned.
    const EXPORT_SCALE = 3;
    // Bulk renders many pages, so it trades a little crispness for speed + memory:
    // scale 2 is ~2.25× fewer pixels than scale 3 — the single biggest lever on
    // render time AND PDF size. Raise toward 3 for sharper pages, drop to 1.5 for
    // a faster, lighter run on a large roster.
    const BULK_EXPORT_SCALE = 2;

    // Wait until the browser has committed and painted the latest render, and every
    // <img> inside the container has decoded. This replaces the old fixed sleep(1200)
    // guess: it is faster (no wasted waiting) AND reliable (we wait on real readiness,
    // not a timer that may be too short on a slow iframe or too long otherwise).
    const nextFrame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

    const waitForRenderReady = async (container) => {
        await nextFrame(); // let React commit + the browser lay out and paint the new record
        if (container) {
            const imgs = Array.from(container.querySelectorAll('img'));
            await Promise.all(imgs.map(img => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                return img.decode().catch(() => new Promise(r => { img.onload = img.onerror = r; }));
            }));
        }
        if (document.fonts && document.fonts.ready) {
            try { await document.fonts.ready; } catch (e) { /* ignore */ }
        }
    };

    // Crop the html2canvas output to exactly the page box (removes scroll overflow).
    const cropCanvas = (sourceCanvas, width, height, scale) => {
        const s = scale || EXPORT_SCALE;
        const newCanvas = document.createElement('canvas');
        newCanvas.width = width * s;
        newCanvas.height = height * s;
        const ctx = newCanvas.getContext('2d');
        ctx.drawImage(sourceCanvas, 0, 0, newCanvas.width, newCanvas.height, 0, 0, newCanvas.width, newCanvas.height);
        return newCanvas;
    };

    // Pre-fetch + pre-decode every attachment image across ALL given records in one
    // pass, so the per-record capture loop never waits on the network. Dedupes by URL
    // and commits the cache once. Pre-decoding warms the browser image cache so the
    // base64 source paints on the very next frame.
    const prepareAllRecordsForPrint = async (recordsToPrint) => {
        const currentElements = elementsRef.current;
        const currentCache = imageCacheRef.current;
        const cacheUpdates = {};

        const urlsForRecord = (record) => {
            const urls = [];
            const collect = (el) => {
                if (el.type === 'field' && record && el.fieldId) {
                    const raw = safeGetCellValue(record, table, el.fieldId);
                    if (Array.isArray(raw) && raw[0] && raw[0].url) urls.push(raw[0].url);
                }
                if (el.type === 'stack' && el.children) el.children.forEach(collect);
            };
            currentElements.forEach(collect);
            return urls;
        };

        // Fetch + decode with bounded concurrency (sequential awaits made the
        // "Preparing images" phase scale linearly with roster size). 6 workers pull
        // from a shared, already-deduped queue.
        const allUrls = [...new Set(recordsToPrint.flatMap(urlsForRecord))].filter(u => !currentCache[u]);
        const CONCURRENCY = 6;
        let idx = 0;
        const worker = async () => {
            while (idx < allUrls.length) {
                const url = allUrls[idx++];
                const base64 = await fetchImageAsBase64(url);
                if (base64) {
                    cacheUpdates[url] = base64;
                    try { const im = new Image(); im.src = base64; await im.decode(); } catch (e) { /* ignore */ }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allUrls.length) }, worker));
        if (Object.keys(cacheUpdates).length > 0) {
            setImageCache(prev => ({ ...prev, ...cacheUpdates }));
        }

        // Pre-bake blurred backdrops for any blur-fill images, using the merged cache
        // so it doesn't depend on the setImageCache above having flushed yet.
        const mergedCache = { ...currentCache, ...cacheUpdates };
        const blurTargets = recordsToPrint.flatMap(r => blurTargetsForRecord(r, mergedCache));
        await ensureBlurForTargets(blurTargets);
    };

    // Capture the live page container to a cropped PNG data URL.
    // format: 'PNG' (lossless, large — fine for a single card) or 'JPEG' (much
    // smaller — required for bulk so the in-memory PDF string stays under V8's
    // max length). JPEG has no alpha, so fill transparent areas with white.
    const capturePageImage = async (format = 'PNG', quality = 0.9, scale = EXPORT_SCALE, ps = null) => {
        const style = ps || pageStyle;
        await waitForRenderReady(pageRef.current);
        const canvas = await html2canvas(pageRef.current, {
            scale: scale,
            useCORS: true,
            allowTaint: false,
            backgroundColor: format === 'JPEG' ? '#ffffff' : null,
            width: style.width,
            height: style.height,
            windowWidth: style.width,
            windowHeight: style.height,
            scrollX: 0,
            scrollY: 0,
            x: 0,
            y: 0,
            imageTimeout: 0,   // images are pre-decoded; don't sit in load-wait loops
            logging: false
        });
        const cropped = cropCanvas(canvas, style.width, style.height, scale);
        return format === 'JPEG'
            ? cropped.toDataURL('image/jpeg', quality)
            : cropped.toDataURL('image/png');
    };

    // Overlay real (vector, clickable) hyperlinks onto the current PDF page by scanning
    // the DOM. unit is 'px' and matches the container, so no scaling math is needed.
    const addPageLinks = (pdf, pageNumber) => {
        const containerRect = pageRef.current.getBoundingClientRect();
        pageRef.current.querySelectorAll('[data-link-url]').forEach(el => {
            const url = el.getAttribute('data-link-url');
            if (!url) return;
            const rect = el.getBoundingClientRect();
            const opts = { url };
            if (pageNumber) opts.pageNumber = pageNumber;
            pdf.link(rect.left - containerRect.left, rect.top - containerRect.top, rect.width, rect.height, opts);
        });
    };

    const generatePDF = async () => {
        if (!pageRef.current || !currentRecord) return;
        setIsExporting(true);
        const forceRoster = designMode === 'title';
        try {
            // Single export is always the current roster card, even if the title-page
            // editor is open — force the roster render target first.
            if (forceRoster) { setExportMode('roster'); await nextFrame(); await nextFrame(); }
            const rosterPS = { ...DEFAULT_PAGE_STYLE, ...(globalConfig.get('pageStyle') || {}) };

            setExportProgress("Preparing images...");
            await prepareAllRecordsForPrint([currentRecord]);

            setExportProgress("Generating PDF...");
            const orientation = rosterPS.width > rosterPS.height ? 'l' : 'p';
            const pdf = new jsPDF({ orientation, unit: 'px', format: [rosterPS.width, rosterPS.height] });

            const imgData = await capturePageImage('PNG', 0.9, EXPORT_SCALE, rosterPS);
            pdf.addImage(imgData, 'PNG', 0, 0, rosterPS.width, rosterPS.height, undefined, 'FAST');
            addPageLinks(pdf);

            pdf.save(`Roster-${currentRecord.name}.pdf`);
        } catch (err) {
            console.error("Single export failed:", err);
            alert("Export failed: " + (err && err.message ? err.message : err));
        } finally {
            setExportProgress('');
            setIsExporting(false);
            if (forceRoster) setExportMode(null);
        }
    };

    const generateBulkPDF = async () => {
        if (!pageRef.current || filteredRecords.length === 0) return;
        if (!confirm(`This will export ${filteredRecords.length} records. It may take a moment. Continue?`)) return;

        setIsExporting(true);
        const records = filteredRecords;   // snapshot so the list can't shift mid-export
        const savedIndex = recordIndex;    // restore the user's view when we're done
        try {
            // Fetch + decode every record image once, up front. The loop below then never
            // waits on the network — only on the (fast) per-record render.
            setExportProgress('Preparing images...');
            await prepareAllRecordsForPrint(records);

            // Read styles straight from globalConfig: this async function closed over a
            // (now stale) reactive pageStyle, so we can't trust it once exportMode flips.
            const rosterPS = { ...DEFAULT_PAGE_STYLE, ...(globalConfig.get('pageStyle') || {}) };
            const titlePS = { ...DEFAULT_PAGE_STYLE, ...(globalConfig.get('titlePageStyle') || {}) };
            const includeTitle = !!globalConfig.get('titlePageStyle') && globalConfig.get('titlePageEnabled') !== false;

            const rosterOrientation = rosterPS.width > rosterPS.height ? 'l' : 'p';
            const firstPS = includeTitle ? titlePS : rosterPS;
            const firstOrientation = firstPS.width > firstPS.height ? 'l' : 'p';
            const pdf = new jsPDF({ orientation: firstOrientation, unit: 'px', format: [firstPS.width, firstPS.height], compress: true });

            let pageCount = 0;

            // 1. TITLE PAGE — rendered once, standalone, as the first page.
            if (includeTitle) {
                setExportProgress('Rendering title page');
                setExportMode('title');
                await nextFrame(); await nextFrame();
                try {
                    const imgData = await capturePageImage('JPEG', 0.9, BULK_EXPORT_SCALE, titlePS);
                    pdf.addImage(imgData, 'JPEG', 0, 0, titlePS.width, titlePS.height, undefined, 'FAST');
                    addPageLinks(pdf, 1);
                    pageCount = 1;
                } catch (err) {
                    console.error("Title page export failed", err);
                }
                setExportMode('roster');
                await nextFrame(); await nextFrame();
            } else {
                setExportMode('roster');
                await nextFrame();
            }

            // 2. ROSTER — one page per record.
            for (let i = 0; i < records.length; i++) {
                setExportProgress(`Rendering ${i + 1} of ${records.length}`);
                setRecordIndex(i);
                try {
                    const imgData = await capturePageImage('JPEG', 0.9, BULK_EXPORT_SCALE, rosterPS); // lighter scale + JPEG
                    if (pageCount > 0) pdf.addPage([rosterPS.width, rosterPS.height], rosterOrientation);
                    pdf.addImage(imgData, 'JPEG', 0, 0, rosterPS.width, rosterPS.height, undefined, 'FAST');
                    addPageLinks(pdf, pageCount + 1);
                    pageCount++;
                } catch (err) {
                    console.error(`Error exporting record ${i} (${records[i] && records[i].name})`, err);
                }
            }

            pdf.save(`Bulk_Export_${records.length}_Records.pdf`);
        } catch (err) {
            console.error("Bulk export failed:", err);
            alert("Bulk export failed: " + (err && err.message ? err.message : err));
        } finally {
            setExportProgress('');
            setIsExporting(false);
            setExportMode(null);
            setRecordIndex(savedIndex);
        }
    };

    // Export one PDF per distinct value of the roster-filter field: scopes the roster
    // (and the title page's {filter} text) to each value in turn, saving a file per
    // value (Danny.pdf, Will.pdf, ...). Each file gets its own title page + cards.
    const sanitizeFileName = (s) => (String(s || 'value').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'value');

    const exportPerFilterValue = async () => {
        if (!pageRef.current) return;
        if (!topFilterRow || !topFilterField) {
            alert("Add a filter at the top and pick the field to split by (e.g. Manager(s)). The value box can stay empty.");
            return;
        }
        const fieldId = topFilterRow.fieldId;
        const distinct = records
            ? [...new Set(records.flatMap(r => getFieldValueNames(r, table, fieldId)))]
                .filter(v => v !== '' && v != null).sort()
            : [];
        if (distinct.length === 0) { alert("No values found in that field."); return; }
        if (!confirm(`This exports ${distinct.length} separate PDFs (one per value of ${topFilterField.name}). Your browser may ask permission to download multiple files. Continue?`)) return;

        setIsExporting(true);
        const savedIndex = recordIndex;
        const savedFilters = filters;
        // Clear typed keywords while we run so the override alone defines each subset.
        setFilters(filters.map(f => ({ ...f, keyword: '' })));
        try {
            const rosterPS = { ...DEFAULT_PAGE_STYLE, ...(globalConfig.get('pageStyle') || {}) };
            const titlePS = { ...DEFAULT_PAGE_STYLE, ...(globalConfig.get('titlePageStyle') || {}) };
            const includeTitle = !!globalConfig.get('titlePageStyle') && globalConfig.get('titlePageEnabled') !== false;
            const rosterOrientation = rosterPS.width > rosterPS.height ? 'l' : 'p';

            for (let v = 0; v < distinct.length; v++) {
                const value = distinct[v];
                setExportProgress(`Value ${v + 1} of ${distinct.length}: ${value}`);

                // Scope roster + {filter} to this exact value, on the roster render target.
                setFilterValueOverride({ fieldId, value });
                setExportMode('roster');
                await nextFrame(); await nextFrame();

                const subset = filteredRecordsRef.current;
                if (!subset || subset.length === 0) continue; // nothing matches this value

                await prepareAllRecordsForPrint(subset);

                const firstPS = includeTitle ? titlePS : rosterPS;
                const firstOrientation = firstPS.width > firstPS.height ? 'l' : 'p';
                const pdf = new jsPDF({ orientation: firstOrientation, unit: 'px', format: [firstPS.width, firstPS.height], compress: true });
                let pageCount = 0;

                if (includeTitle) {
                    setExportMode('title');
                    await nextFrame(); await nextFrame();
                    try {
                        const imgData = await capturePageImage('JPEG', 0.9, BULK_EXPORT_SCALE, titlePS);
                        pdf.addImage(imgData, 'JPEG', 0, 0, titlePS.width, titlePS.height, undefined, 'FAST');
                        addPageLinks(pdf, 1);
                        pageCount = 1;
                    } catch (err) { console.error("Title page failed for", value, err); }
                    setExportMode('roster');
                    await nextFrame(); await nextFrame();
                }

                for (let i = 0; i < subset.length; i++) {
                    setExportProgress(`${value}: ${i + 1} of ${subset.length}`);
                    setRecordIndex(i);
                    try {
                        const imgData = await capturePageImage('JPEG', 0.9, BULK_EXPORT_SCALE, rosterPS);
                        if (pageCount > 0) pdf.addPage([rosterPS.width, rosterPS.height], rosterOrientation);
                        pdf.addImage(imgData, 'JPEG', 0, 0, rosterPS.width, rosterPS.height, undefined, 'FAST');
                        addPageLinks(pdf, pageCount + 1);
                        pageCount++;
                    } catch (err) { console.error(`Record ${i} failed for ${value}`, err); }
                }

                if (pageCount > 0) pdf.save(`${sanitizeFileName(value)}.pdf`);
                await new Promise(res => setTimeout(res, 400)); // space out downloads
            }
        } catch (err) {
            console.error("Per-value export failed:", err);
            alert("Per-value export failed: " + (err && err.message ? err.message : err));
        } finally {
            setExportProgress('');
            setIsExporting(false);
            setExportMode(null);
            setFilterValueOverride(null);
            setFilters(savedFilters);
            setRecordIndex(savedIndex);
        }
    };
    const getPageBackgroundStyle = () => {
        const activeImageUrl = sessionImage || pageStyle.imageUrl;
        if (pageStyle.type === 'image' && activeImageUrl) {
            return { 
                backgroundImage: `url(${activeImageUrl})`, 
                backgroundSize: 'cover', 
                backgroundPosition: 'center' 
            };
        } else if (pageStyle.type === 'gradient') {
            return { background: `linear-gradient(to bottom, ${pageStyle.color1}, ${pageStyle.color2})` };
        } else {
            return { backgroundColor: pageStyle.color1 };
        }
    };

    // Does this node render anything for the current record? Mirrors the collapse rules
    // below: a linked field with no value is empty; a nested stack is empty when all of
    // its descendants are empty. Used so an empty nested stack collapses (and its
    // siblings reflow) the same way an empty field does.
    const nodeHasContent = (node) => {
        if (!node) return false;
        if (node.type === 'stack') return (node.children || []).some(nodeHasContent);
        if (node.fieldId && currentRecord) return !!safeGetCellValueAsString(currentRecord, table, node.fieldId);
        if (node.type === 'static' && node.displayMode === 'text' && !node.useFilterValue) {
            return !!(node.text && node.text.trim().length);
        }
        return true; // static images/icons/shapes, filter-value text, or field without a record
    };

    // Recursively render a stack's items on the canvas. Stacks can contain stacks, so
    // each child is addressed by a PATH (basePath + child.id) for selection/highlight.
    const renderStackNode = (stack, rootId, basePath) => (
        <div style={{
            width: '100%', height: '100%', display: 'flex',
            flexDirection: stack.stackDirection,
            justifyContent: stack.stackAlign,
            alignItems: 'center',
            gap: `${stack.stackSpacing}px`,
            padding: '5px',
            flexWrap: 'wrap',
            overflow: 'hidden'
        }}>
            {(stack.children || []).map(child => {
                // Collapse linked fields that are empty/missing for this record.
                if (child.fieldId && currentRecord) {
                    const val = safeGetCellValueAsString(currentRecord, table, child.fieldId);
                    if (!val) return null;
                }
                // Collapse a nested stack that has nothing to show, so its siblings
                // reflow (e.g. an empty "Notable Works" lets "Managers" slide to Start).
                if (child.type === 'stack' && !nodeHasContent(child)) return null;
                const childPath = [...basePath, child.id];
                const isChildSelected = !isExporting && selectedElementId === rootId && pathsEqual(selectedChildPath, childPath);
                const inner = child.type === 'stack'
                    ? renderStackNode(child, rootId, childPath)
                    : renderElementContent(child);
                return (
                    <div
                        key={child.id}
                        onClick={(e) => {
                            e.stopPropagation();
                            setSelectedElementId(rootId);
                            setSelectedChildPath(childPath);
                            setSelectedIds([rootId]);
                            setEditMode('elements');
                        }}
                        style={{
                            ...child.style,
                            width: `${child.width}px`,
                            height: `${child.height}px`,
                            flexShrink: 0,
                            position: 'relative',
                            border: isChildSelected
                                ? '2px solid #fa243c'
                                : (child.style.borderWidth && child.style.borderWidth !== '0px'
                                    ? `${child.style.borderWidth} ${child.style.borderStyle} ${child.style.borderColor}` : 'none'),
                            cursor: 'pointer'
                        }}
                    >
                        {inner}
                    </div>
                );
            })}
        </div>
    );

    // Shared visual rendering for both Root Elements and Stack Children
    const renderElementContent = (el) => {
        // 1. SHAPES
        if (el.type === 'shape') {
            return <div style={{width: '100%', height: '100%'}} />;
        }
        // 2. TEXT (Static or Field)
        else if (el.displayMode === 'text') {
            let textVal = el.text || '';
            if (el.type === 'field' && currentRecord && el.fieldId) {
                if (el.useCustomLabel && el.customLabelText) {
                    textVal = el.customLabelText;
                } else {
                    // FIX: Use safe wrapper — fieldId may be from a different base
                    textVal = safeGetCellValueAsString(currentRecord, table, el.fieldId);
                }
            }
            // Roster-filter-driven text: shows the top filter's value (or this element's
            // default when nothing is filtered), with an optional static suffix appended
            // — so "Danny" + "Roster" renders "Danny Roster". Overrides the element text.
            if (el.useFilterValue) {
                const base = computeFilterText(el);
                const suffix = el.filterSuffix || '';
                textVal = [base, suffix].filter(s => s !== '' && s != null).join(' ');
            }
            // Per-element find/replace (supports \n -> line break), applied live to
            // whatever this display renders, for every record.
            const hasRules = Array.isArray(el.replacements) && el.replacements.length > 0;
            if (hasRules) textVal = applyReplacements(textVal, el.replacements);
            // pre-wrap only when rules exist, so existing layouts are untouched.
            const ws = hasRules ? 'pre-wrap' : undefined;
            if (el.autoFitText) {
                return (
                    <AutoFitText
                        text={textVal}
                        baseFontSize={el.style && el.style.fontSize}
                        boxW={el.width}
                        boxH={el.height}
                        whiteSpace={ws}
                    />
                );
            }
            return (
                <div style={{width: '100%', height: '100%', wordWrap: 'break-word', overflow: 'hidden', whiteSpace: ws || 'normal'}}>
                    {textVal}
                </div>
            );
        } 
        // 3. IMAGES (Attachments)
        else if (el.displayMode === 'image') {
            const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Crect width='150' height='150' fill='%23e0e0e0'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%23999' font-size='12' font-family='sans-serif'%3ENo Image%3C/text%3E%3C/svg%3E";
            let imgSrc = placeholder;
            let url = null;
            let blurKey = null;
            if (el.type === 'field' && currentRecord && el.fieldId) {
                const val = safeGetCellValue(currentRecord, table, el.fieldId);
                if (Array.isArray(val) && val[0] && val[0].url) {
                    url = val[0].url;
                    imgSrc = imageCache[url] || url;
                    blurKey = url;
                }
            } else if (el.staticImage) {
                imgSrc = el.staticImage;
                blurKey = 'static:' + el.id;
            }

            const hasImage = imgSrc !== placeholder;

            // Blur-fill: show the WHOLE photo (contain) over a blurred, zoomed copy of
            // itself that fills the empty space. Falls back to the plain photo behind
            // until the baked blur is ready (always ready before a bulk export).
            if (el.blurFill && hasImage) {
                const blurredSrc = (blurKey && blurCache[blurKey]) ? blurCache[blurKey] : imgSrc;
                return (
                    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000000' }}>
                        <div style={{
                            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                            backgroundImage: `url("${blurredSrc}")`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            backgroundRepeat: 'no-repeat'
                        }} />
                        <div style={{
                            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                            backgroundImage: `url("${imgSrc}")`,
                            backgroundSize: 'contain',
                            backgroundPosition: 'center',
                            backgroundRepeat: 'no-repeat'
                        }} />
                    </div>
                );
            }

            return (
                <div 
                    style={{
                        width: '100%', 
                        height: '100%', 
                        backgroundImage: `url("${imgSrc}")`,
                        backgroundSize: el.imageFit === 'contain' ? 'contain' : 'cover',
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat'
                    }} 
                />
            );
        }
        // 4. ICONS
        else if (el.displayMode === 'icon') {
            let iconSrc = DEFAULT_ICON;
            if (el.iconType === 'custom' && el.customIcon) iconSrc = el.customIcon;
            else if (el.iconType && ICONS[el.iconType]) iconSrc = ICONS[el.iconType];
            
            let linkUrl = "";
            if (el.type === 'field' && currentRecord && el.fieldId) {
                // FIX: Use safe wrapper
                linkUrl = safeGetCellValueAsString(currentRecord, table, el.fieldId);
            }

            // Render as a real <img>, not a CSS background. html2canvas rasterizes a
            // background SVG at the element's small on-screen box and then upscales that
            // bitmap (blurry). An <img> keeps the SVG's large intrinsic size, so the
            // browser re-rasterizes it crisply when html2canvas draws it at EXPORT_SCALE.
            return (
                <img
                    data-link-url={linkUrl}
                    src={iconSrc}
                    alt=""
                    draggable={false}
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        objectPosition: 'center',
                        display: 'block',
                        pointerEvents: 'none'
                    }}
                />
            );
        }
        return null;
    };

    const selectedRootElement = elements.find(e => e.id === selectedElementId);
    const activeElement = selectedRootElement
        ? getChildByPath(selectedRootElement, selectedChildPath)
        : null;

    // 7. MAIN UI
    return (
        <Box display="flex" height="100vh" overflow="hidden">

            {/* Always-mounted hidden input for static image uploads (the add panel
                unmounts once an element is selected, so this can't live there). */}
            <input
                ref={staticImageInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleStaticImageUpload}
            />
            
            {/* --- SIDEBAR --- */}
            <Box width="320px" borderRight="thick" display="flex" flexDirection="column" backgroundColor="#f9f9f9">
                {designMode === 'title' && (
                    <Box padding={2} backgroundColor="#fff4e5" borderBottom="thick" display="flex" justifyContent="space-between" alignItems="center">
                        <Text size="small" fontWeight="bold">Editing title page</Text>
                        <Button size="small" variant="primary" icon="chevronLeft" onClick={() => switchMode('roster')}>
                            Back to roster
                        </Button>
                    </Box>
                )}
                <Box display="flex" borderBottom="thick" backgroundColor="white">
                    <Box 
                        flex="1" padding={3} textAlign="center" cursor="pointer"
                        backgroundColor={editMode === 'elements' ? '#eee' : 'white'}
                        onClick={() => setEditMode('elements')}
                        fontWeight={editMode === 'elements' ? 'bold' : 'normal'}
                    >
                        Elements
                    </Box>
                    <Box 
                        flex="1" padding={3} textAlign="center" cursor="pointer"
                        backgroundColor={editMode === 'page' ? '#eee' : 'white'}
                        onClick={() => setEditMode('page')}
                        fontWeight={editMode === 'page' ? 'bold' : 'normal'}
                    >
                        Page Bg
                    </Box>
                </Box>

                <Box flex="1" overflowY="auto" padding={3}>
                    {editMode === 'page' && (
                        <>
                            <Box marginBottom={3} padding={2} border="thick" borderRadius="default" backgroundColor="white">
                                <Heading size="xsmall" marginBottom={1}>Title Page</Heading>
                                <Text size="xsmall" textColor="light" marginBottom={2}>
                                    A standalone cover slide added to the front of the bulk PDF. It has its own layout and background and uses all the same tools.
                                </Text>
                                {designMode === 'roster' ? (
                                    <Button icon="file" variant="primary" size="small" width="100%" marginBottom={2} onClick={() => switchMode('title')}>
                                        Design title page
                                    </Button>
                                ) : (
                                    <Button icon="chevronLeft" variant="default" size="small" width="100%" marginBottom={2} onClick={() => switchMode('roster')}>
                                        Back to roster card
                                    </Button>
                                )}
                                {titlePageExists && (
                                    <Box display="flex" alignItems="center">
                                        <Switch value={titlePageEnabled} onChange={setTitlePageEnabled} marginRight={2} />
                                        <Text size="small">Include in bulk export</Text>
                                    </Box>
                                )}
                            </Box>

                            <Heading size="xsmall" marginBottom={2}>Page Dimensions</Heading>
                            <Box display="flex" gap={2} marginBottom={3}>
                                <Box flex="1">
                                    <Label>Width (px)</Label>
                                    <Input 
                                        type="number"
                                        value={pageStyle.width || DEFAULT_PAGE_WIDTH}
                                        onChange={e => updatePageStyle({ width: parseInt(e.target.value) || DEFAULT_PAGE_WIDTH })}
                                    />
                                </Box>
                                <Box flex="1">
                                    <Label>Height (px)</Label>
                                    <Input 
                                        type="number"
                                        value={pageStyle.height || DEFAULT_PAGE_HEIGHT}
                                        onChange={e => updatePageStyle({ height: parseInt(e.target.value) || DEFAULT_PAGE_HEIGHT })}
                                    />
                                </Box>
                            </Box>

                            <Heading size="xsmall" marginBottom={2}>Typography</Heading>
                            <FormField label="Base font (new elements + quick apply)">
                                <Select
                                    options={FONT_OPTIONS}
                                    value={pageStyle.fontFamily || DEFAULT_ELEMENT_STYLE.fontFamily}
                                    onChange={val => updatePageStyle({ fontFamily: val })}
                                />
                            </FormField>
                            <Button
                                icon="font"
                                variant="default"
                                size="small"
                                marginBottom={3}
                                onClick={() => applyFontToAll(pageStyle.fontFamily)}
                            >
                                Apply base font to all elements
                            </Button>

                            <Heading size="xsmall" marginBottom={2}>Page Background</Heading>
                            <FormField label="Background Type">
                                <Select 
                                    options={[
                                        {value: 'solid', label: 'Solid Color'},
                                        {value: 'gradient', label: 'Gradient'},
                                        {value: 'image', label: 'Image / Upload'},
                                    ]}
                                    value={pageStyle.type}
                                    onChange={val => updatePageStyle({type: val})}
                                />
                            </FormField>

                            {pageStyle.type === 'solid' && (
                                <Box marginBottom={3}>
                                    <Label>Color</Label>
                                    <Box display="flex" gap={2}>
                                        <Input type="color" value={pageStyle.color1} onChange={e => updatePageStyle({color1: e.target.value})} width="50px" style={{cursor:'pointer'}}/>
                                        <Input value={pageStyle.color1} onChange={e => updatePageStyle({color1: e.target.value})} />
                                    </Box>
                                </Box>
                            )}

                            {pageStyle.type === 'gradient' && (
                                <Box marginBottom={3}>
                                    <Label>Top Color</Label>
                                    <Box display="flex" gap={2} marginBottom={2}>
                                        <Input type="color" value={pageStyle.color1} onChange={e => updatePageStyle({color1: e.target.value})} width="50px" style={{cursor:'pointer'}}/>
                                        <Input value={pageStyle.color1} onChange={e => updatePageStyle({color1: e.target.value})} />
                                    </Box>
                                    <Label>Bottom Color</Label>
                                    <Box display="flex" gap={2}>
                                        <Input type="color" value={pageStyle.color2} onChange={e => updatePageStyle({color2: e.target.value})} width="50px" style={{cursor:'pointer'}}/>
                                        <Input value={pageStyle.color2} onChange={e => updatePageStyle({color2: e.target.value})} />
                                    </Box>
                                </Box>
                            )}

                            {pageStyle.type === 'image' && (
                                <Box marginBottom={3}>
                                    <Label>Upload Image</Label>
                                    <Input 
                                        ref={fileInputRef}
                                        type="file" 
                                        accept="image/*"
                                        onChange={handleFileUpload} 
                                        style={{padding: '5px'}}
                                    />
                                    {pageStyle.imageUrl && (
                                        <Button size="small" variant="danger" marginTop={2} onClick={() => updatePageStyle({imageUrl: ''})}>
                                            Remove Image
                                        </Button>
                                    )}
                                </Box>
                            )}
                        </>
                    )}

                    {editMode === 'elements' && !selectedElementId && (
                        <>
                            {/* ── ROSTER FILTER (saved with template) ── */}
                            <Heading size="xsmall" marginBottom={2}>Roster Filter</Heading>
                            <Text size="small" textColor="light" marginBottom={2}>
                                Limit which records load by a field's value (e.g. only Shortlist and Ready). Persists across all templates — loading a template won't change it.
                            </Text>
                            <FormField label="Filter field">
                                <FieldPicker
                                    table={table}
                                    field={rosterFilterField}
                                    onChange={setRosterFilterField}
                                    shouldAllowPickingNone={true}
                                    placeholder="No filter — show all"
                                />
                            </FormField>
                            {rosterFilterField && (
                                <Box marginBottom={3}>
                                    <Box display="flex" justifyContent="space-between" alignItems="center" marginBottom={1}>
                                        <Text size="small" textColor="light">Include values</Text>
                                        <Box display="flex" gap={1}>
                                            <Button size="small" variant="default" onClick={() => updateRosterFilter({ fieldId: rosterFilter.fieldId, values: rosterAvailableValues })}>All</Button>
                                            <Button size="small" variant="default" onClick={() => updateRosterFilter({ fieldId: rosterFilter.fieldId, values: [] })}>None</Button>
                                        </Box>
                                    </Box>
                                    {rosterAvailableValues.length === 0 ? (
                                        <Text size="small" textColor="light">No values found for this field.</Text>
                                    ) : (
                                        <Box border="default" borderRadius="default" padding={2} backgroundColor="white" style={{ maxHeight: '180px', overflowY: 'auto' }}>
                                            {rosterAvailableValues.map(val => (
                                                <Switch
                                                    key={val}
                                                    label={val}
                                                    value={rosterFilterValues.includes(val)}
                                                    onChange={() => toggleRosterValue(val)}
                                                    marginBottom={1}
                                                />
                                            ))}
                                        </Box>
                                    )}
                                    {rosterFilterActive && (
                                        <Text size="small" textColor="light" marginTop={1}>
                                            Showing records where {rosterFilterField.name} matches {rosterFilterValues.length} selected value(s) — {filteredRecords.length} of {records ? records.length : 0}.
                                        </Text>
                                    )}
                                </Box>
                            )}

                            {/* ── TEMPLATE MANAGEMENT ── */}
                            <Heading size="xsmall" marginBottom={2}>Template</Heading>
                            <Box display="flex" flexDirection="column" gap={2} marginBottom={1}>
                                <Button
                                    icon="upload"
                                    onClick={saveAsDefaultTemplate}
                                    variant="primary"
                                >
                                    Save as Default Template
                                </Button>
                                <Button
                                    icon="download"
                                    onClick={exportTemplateJSON}
                                    variant="secondary"
                                >
                                    Export template.json
                                </Button>
                                <Button
                                    icon="redo"
                                    onClick={loadDefaultTemplate}
                                    variant="secondary"
                                >
                                    {globalConfig.get('defaultTemplate') ? 'Load Saved Default' : 'Load template.json'}
                                </Button>
                            </Box>
                            <Text size="xsmall" textColor="light" marginBottom={3}>
                                {globalConfig.get('defaultTemplate')
                                    ? '✓ A saved default template exists for this workspace.'
                                    : 'No saved default yet — using template.json as fallback.'}
                            </Text>

                            <Box height="1px" backgroundColor="lightGray2" marginBottom={3} />

                            {/* ── ADD ELEMENTS ── */}
                            <Heading size="xsmall" marginBottom={2}>Add Elements</Heading>
                            <Box display="flex" flexDirection="column" gap={2} marginBottom={3}>
                                <Button onClick={() => addElement('static')}>+ Add Static Text</Button>
                                <Button onClick={() => addElement('field')}>+ Add Record Field</Button>
                                <Button onClick={() => addElement('stack')}>+ Add Stack (Dynamic Row)</Button>
                                <Button onClick={() => addShape('rectangle')}>+ Add Rectangle</Button>
                                <Button onClick={() => addShape('line')}>+ Add Line</Button>
                                <Button onClick={addStaticImage}>+ Add Image (Upload)</Button>
                            </Box>

                            <Heading size="xsmall" marginBottom={2}>Align Selected</Heading>
                            <Text textColor="light">Select an element to see options</Text>
                        </>
                    )}

                    {editMode === 'elements' && selectedIds.length >= 2 && (
                        <>
                            <Box display="flex" justifyContent="space-between" alignItems="center" marginBottom={2}>
                                <Heading size="xsmall">{selectedIds.length} elements selected</Heading>
                                <Box display="flex" gap={1}>
                                    <Button size="small" variant="default" icon="duplicate" onClick={duplicateSelected} aria-label="Duplicate" />
                                    <Button size="small" variant="danger" icon="trash" onClick={deleteSelected} aria-label="Delete" />
                                    <Button size="small" variant="default" onClick={() => { setSelectedIds([]); setSelectedElementId(null); }}>Clear</Button>
                                </Box>
                            </Box>
                            <Text size="small" textColor="light" marginBottom={2}>
                                Align and distribute relative to each other. Shift/Cmd-click elements to add or remove from the selection; drag any one to move them together.
                            </Text>

                            <Label>Align</Label>
                            <Box display="flex" gap={1} marginBottom={2}>
                                <Button size="small" onClick={() => alignSelected('left')}>Left</Button>
                                <Button size="small" onClick={() => alignSelected('hcenter')}>Center</Button>
                                <Button size="small" onClick={() => alignSelected('right')}>Right</Button>
                            </Box>
                            <Box display="flex" gap={1} marginBottom={3}>
                                <Button size="small" onClick={() => alignSelected('top')}>Top</Button>
                                <Button size="small" onClick={() => alignSelected('vcenter')}>Middle</Button>
                                <Button size="small" onClick={() => alignSelected('bottom')}>Bottom</Button>
                            </Box>

                            <Label>Distribute {selectedIds.length < 3 ? '(needs 3+)' : ''}</Label>
                            <Box display="flex" gap={1} marginBottom={2}>
                                <Button size="small" disabled={selectedIds.length < 3} onClick={() => distributeSelected('h')}>Horizontally</Button>
                                <Button size="small" disabled={selectedIds.length < 3} onClick={() => distributeSelected('v')}>Vertically</Button>
                            </Box>
                        </>
                    )}

                    {editMode === 'elements' && selectedElementId && selectedIds.length < 2 && activeElement && (
                        <>
                            <Box display="flex" justifyContent="space-between" alignItems="center" marginBottom={3}>
                                <Heading size="xsmall">Edit {selectedChildPath.length ? (activeElement.type === 'stack' ? 'Nested Stack' : 'Item') : 'Element'}</Heading>
                                <Box display="flex" gap={1}>
                                    {selectedChildPath.length === 0 && (
                                        <Button size="small" variant="default" icon="duplicate" onClick={duplicateSelected}>Duplicate</Button>
                                    )}
                                    <Button size="small" variant="danger" onClick={() => {
                                        if (selectedChildPath.length) {
                                            removeStackItem(selectedChildPath.slice(0, -1), selectedChildPath[selectedChildPath.length - 1]);
                                        } else {
                                            deleteElement(selectedElementId);
                                        }
                                    }}>Delete</Button>
                                </Box>
                            </Box>

                            {selectedChildPath.length > 0 && (
                                <Box display="flex" gap={1} marginBottom={3}>
                                    <Button flex="1" size="small" icon="chevronLeft" onClick={() => setSelectedChildPath(selectedChildPath.slice(0, -1))}>
                                        Back
                                    </Button>
                                    <Button flex="1" size="small" variant="default" icon="expand" onClick={popOutOfStack}>
                                        Pop out
                                    </Button>
                                </Box>
                            )}

                            {/* --- STACK EDITOR — shows for the active stack, root OR nested --- */}
                            {activeElement.type === 'stack' && (
                                <Box marginBottom={3}>
                                    <Label>Stack Layout</Label>
                                    <Box display="flex" gap={1} marginBottom={2}>
                                        <Select
                                            options={[
                                                {value: 'row', label: 'Horizontal Row'},
                                                {value: 'column', label: 'Vertical Column'}
                                            ]}
                                            value={activeElement.stackDirection}
                                            onChange={val => updateSelected({stackDirection: val})}
                                        />
                                    </Box>
                                    <Label>Spacing (px)</Label>
                                    <Input
                                        type="number"
                                        value={activeElement.stackSpacing}
                                        onChange={e => updateSelected({stackSpacing: parseInt(e.target.value) || 0})}
                                        marginBottom={2}
                                    />
                                    <Label>Alignment</Label>
                                    <Select
                                        options={[
                                            {value: 'flex-start', label: 'Start'},
                                            {value: 'center', label: 'Center'},
                                            {value: 'flex-end', label: 'End'},
                                            {value: 'space-between', label: 'Space Between'}
                                        ]}
                                        value={activeElement.stackAlign}
                                        onChange={val => updateSelected({stackAlign: val})}
                                    />

                                    <Heading size="xsmall" marginTop={3} marginBottom={2}>Stack Items</Heading>
                                    <Box display="flex" gap={1} marginBottom={2}>
                                        <Button flex="1" size="small" onClick={() => addStackItem('icon')}>+ Icon</Button>
                                        <Button flex="1" size="small" onClick={() => addStackItem('image')}>+ Image</Button>
                                    </Box>
                                    <Box display="flex" gap={1} marginBottom={2}>
                                        <Button flex="1" size="small" onClick={() => addStackItem('field')}>+ Field</Button>
                                        <Button flex="1" size="small" onClick={() => addStackItem('static')}>+ Text</Button>
                                        <Button flex="1" size="small" onClick={() => addStackItem('stack')}>+ Stack</Button>
                                    </Box>

                                    {(activeElement.children || []).map((child, idx) => (
                                        <Box
                                            key={child.id}
                                            padding={2}
                                            border="default"
                                            marginBottom={2}
                                            borderRadius="default"
                                            backgroundColor="white"
                                            style={{cursor: 'pointer', borderLeft: child.type === 'stack' ? '4px solid #f5a623' : '4px solid #2d7ff9'}}
                                            onClick={() => setSelectedChildPath([...selectedChildPath, child.id])}
                                        >
                                            <Box display="flex" justifyContent="space-between" alignItems="center">
                                                <Text fontWeight="bold">Item {idx + 1}: {child.type === 'stack' ? 'Nested Stack' : (child.displayMode || child.type)}</Text>
                                                <Box display="flex" alignItems="center" gap={1}>
                                                    <Button
                                                        size="small"
                                                        variant="default"
                                                        icon="chevronUp"
                                                        aria-label="Move up"
                                                        disabled={idx === 0}
                                                        onClick={(e) => { e.stopPropagation(); moveStackItem(selectedChildPath, child.id, -1); }}
                                                    />
                                                    <Button
                                                        size="small"
                                                        variant="default"
                                                        icon="chevronDown"
                                                        aria-label="Move down"
                                                        disabled={idx === ((activeElement.children || []).length - 1)}
                                                        onClick={(e) => { e.stopPropagation(); moveStackItem(selectedChildPath, child.id, 1); }}
                                                    />
                                                    <Icon name={child.type === 'stack' ? 'chevronRight' : 'edit'} size={12} />
                                                </Box>
                                            </Box>
                                            <Text size="xsmall" textColor="light" truncate>
                                                {child.type === 'stack' ? `${(child.children || []).length} item(s)` : (child.fieldId ? 'Linked Field' : child.text || 'Element')}
                                            </Text>
                                        </Box>
                                    ))}
                                </Box>
                            )}

                            {/* --- COMMON PROPERTY EDITORS (Used by both Root Elements and Stack Children) --- */}
                            {activeElement && (
                                <>
                                    {activeElement.type === 'field' && (
                                        <Box marginBottom={3} padding={2} border="default" borderRadius="large">
                                            <Label>Connect to Field</Label>
                                            <FieldPicker
                                                table={table}
                                                field={table.getFieldByIdIfExists(activeElement.fieldId)}
                                                onChange={f => updateSelected({fieldId: f ? f.id : null})}
                                            />
                                            
                                            <Box marginTop={2}>
                                                <Box display="flex" alignItems="center" marginBottom={1}>
                                                    <Switch 
                                                        value={activeElement.useCustomLabel || false}
                                                        onChange={val => updateSelected({useCustomLabel: val})}
                                                        marginRight={2}
                                                    />
                                                    <Text>Use as Conditional Label</Text>
                                                </Box>
                                                {activeElement.useCustomLabel && (
                                                    <Input 
                                                        value={activeElement.customLabelText || ''}
                                                        onChange={e => updateSelected({customLabelText: e.target.value})}
                                                        placeholder="Enter label text..."
                                                    />
                                                )}
                                            </Box>

                                            {currentRecord && activeElement.fieldId && (
                                                <Box marginTop={2} padding={2} backgroundColor="#f0f0f0" borderRadius="default">
                                                    <Text size="xsmall" textColor="light">Current Value:</Text>
                                                    <Text truncate>{safeGetCellValueAsString(currentRecord, table, activeElement.fieldId) || "(Empty)"}</Text>
                                                </Box>
                                            )}
                                            
                                            <Label marginTop={2}>Display Mode</Label>
                                            <Select 
                                                options={[
                                                    {value: 'text', label: 'Text'},
                                                    {value: 'image', label: 'Image (Attachment)'},
                                                    {value: 'icon', label: 'Clickable Icon'},
                                                    {value: 'qr', label: 'QR Code (Future)'}
                                                ]}
                                                value={activeElement.displayMode}
                                                onChange={val => updateSelected({displayMode: val})}
                                            />
                                            
                                            {activeElement.displayMode === 'image' && (
                                                <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                                    <Box display="flex" alignItems="center">
                                                        <Switch
                                                            value={activeElement.blurFill || false}
                                                            onChange={val => updateSelected({ blurFill: val })}
                                                            marginRight={2}
                                                        />
                                                        <Text>Blur-fill background</Text>
                                                    </Box>
                                                    <Text size="xsmall" textColor="light" marginTop={1}>
                                                        Shows the whole photo and fills the empty space with a blurred copy of it, instead of cropping to fill.
                                                    </Text>
                                                </Box>
                                            )}

                                            {activeElement.displayMode === 'icon' && (
                                                <Box marginTop={2}>
                                                    <Label>Icon Type</Label>
                                                    <Select 
                                                        options={[
                                                            {value: 'link', label: 'Generic Link'},
                                                            {value: 'apple', label: 'Apple Music'},
                                                            {value: 'spotify', label: 'Spotify'},
                                                            {value: 'instagram', label: 'Instagram'},
                                                            {value: 'youtube', label: 'YouTube'},
                                                            {value: 'soundcloud', label: 'SoundCloud'},
                                                            {value: 'tiktok', label: 'TikTok'},
                                                            {value: 'custom', label: 'Custom Upload'}
                                                        ]}
                                                        value={activeElement.iconType}
                                                        onChange={val => updateSelected({iconType: val})}
                                                    />
                                                    {activeElement.iconType === 'custom' && (
                                                        <Input 
                                                            ref={iconInputRef}
                                                            type="file" 
                                                            accept="image/*"
                                                            marginTop={2}
                                                            onChange={handleIconUpload}
                                                        />
                                                    )}
                                                </Box>
                                            )}
                                        </Box>
                                    )}

                                    {activeElement.type === 'static' && activeElement.displayMode === 'image' && (
                                        <Box marginBottom={2}>
                                            <Label>Image</Label>
                                            {activeElement.staticImage && (
                                                <Box marginBottom={2} style={{ height: '90px', backgroundImage: `url("${activeElement.staticImage}")`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', border: '1px solid #ddd', borderRadius: '4px' }} />
                                            )}
                                            <Button size="small" icon="upload" onClick={() => staticImageInputRef.current && staticImageInputRef.current.click()}>
                                                {activeElement.staticImage ? 'Replace image' : 'Upload image'}
                                            </Button>
                                            <Box marginTop={2}>
                                                <Label>Fit</Label>
                                                <Select
                                                    options={[
                                                        { value: 'cover', label: 'Fill box (crop)' },
                                                        { value: 'contain', label: 'Fit whole image' },
                                                    ]}
                                                    value={activeElement.imageFit || 'cover'}
                                                    onChange={val => updateSelected({ imageFit: val })}
                                                />
                                            </Box>
                                            <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                                <Box display="flex" alignItems="center">
                                                    <Switch value={activeElement.transparentPng || false} onChange={val => reencodeStaticImage(activeElement, val)} marginRight={2} />
                                                    <Text>Transparent (PNG)</Text>
                                                </Box>
                                                <Text size="xsmall" textColor="light" marginTop={1}>
                                                    Keeps PNG alpha instead of flattening to JPEG. For a transparent image, turn this on and upload the PNG.
                                                </Text>
                                            </Box>
                                            <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                                <Box display="flex" alignItems="center">
                                                    <Switch value={activeElement.blurFill || false} onChange={val => updateSelected({ blurFill: val })} marginRight={2} />
                                                    <Text>Blur-fill background</Text>
                                                </Box>
                                            </Box>
                                        </Box>
                                    )}

                                    {activeElement.type === 'static' && activeElement.displayMode !== 'image' && (
                                        <FormField label="Text Content">
                                            <Input 
                                                value={activeElement.text}
                                                onChange={e => updateSelected({text: e.target.value})}
                                            />
                                        </FormField>
                                    )}

                                    {activeElement.type === 'shape' && (
                                        <Box marginBottom={2}>
                                            <Label>{activeElement.shapeType === 'line' ? 'Line color' : 'Fill color'}</Label>
                                            <Input
                                                type="color"
                                                value={activeElement.style.backgroundColor === 'transparent' ? '#000000' : activeElement.style.backgroundColor}
                                                onChange={e => updateSelectedStyle('backgroundColor', e.target.value)}
                                                style={{ cursor: 'pointer', height: '32px' }}
                                            />
                                            {activeElement.shapeType === 'line' && (
                                                <Box marginTop={2}>
                                                    <Label>Thickness (px)</Label>
                                                    <Input
                                                        type="number"
                                                        step="0.5"
                                                        min="0.5"
                                                        value={activeElement.height}
                                                        onChange={e => updateSelected({ height: Math.max(0.5, parseFloat(e.target.value) || 1) })}
                                                    />
                                                </Box>
                                            )}
                                        </Box>
                                    )}

                                    <Heading size="xsmall" marginTop={3} marginBottom={2}>Styling</Heading>
                                    
                                    {selectedStackChildId && (
                                        <Box marginBottom={2}>
                                            <Label>Dimensions</Label>
                                            <Box display="flex" gap={2}>
                                                <Box flex="1">
                                                    <Text size="xsmall" textColor="light">Width</Text>
                                                    <Input type="number" value={activeElement.width} onChange={e => updateSelected({width: parseInt(e.target.value)||0})} />
                                                </Box>
                                                <Box flex="1">
                                                    <Text size="xsmall" textColor="light">Height</Text>
                                                    <Input type="number" value={activeElement.height} onChange={e => updateSelected({height: parseInt(e.target.value)||0})} />
                                                </Box>
                                            </Box>
                                        </Box>
                                    )}

                                    <Box display="flex" gap={2}>
                                        <Box flex="1">
                                            <Label>Font Size</Label>
                                            <Select 
                                                options={[
                                                    {value: '12px', label: '12'},
                                                    {value: '14px', label: '14'},
                                                    {value: '18px', label: '18'},
                                                    {value: '24px', label: '24'},
                                                    {value: '36px', label: '36'},
                                                    {value: '48px', label: '48'},
                                                    {value: '72px', label: '72'},
                                                ]}
                                                value={activeElement.style.fontSize}
                                                onChange={val => updateSelectedStyle('fontSize', val)}
                                            />
                                        </Box>
                                        <Box flex="1">
                                            <Label>Color</Label>
                                            <Input 
                                                type="color" 
                                                value={activeElement.style.color}
                                                onChange={e => updateSelectedStyle('color', e.target.value)}
                                                style={{cursor:'pointer', height: '32px'}}
                                            />
                                        </Box>
                                    </Box>

                                    {(activeElement.type === 'static' || (activeElement.type === 'field' && activeElement.displayMode === 'text')) && (
                                        <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                            <Box display="flex" alignItems="center">
                                                <Switch
                                                    value={activeElement.autoFitText || false}
                                                    onChange={val => updateSelected({autoFitText: val})}
                                                    marginRight={2}
                                                />
                                                <Text>Auto-fit text to box</Text>
                                            </Box>
                                            {activeElement.autoFitText && (
                                                <Text size="xsmall" textColor="light" marginTop={1}>
                                                    Font size above acts as the maximum; long text shrinks to fit. Resize the box to control wrapping.
                                                </Text>
                                            )}
                                        </Box>
                                    )}

                                    {(activeElement.type === 'static' || (activeElement.type === 'field' && activeElement.displayMode === 'text')) && (
                                        <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                            <Box display="flex" alignItems="center">
                                                <Switch value={activeElement.useFilterValue || false} onChange={val => updateSelected({ useFilterValue: val })} marginRight={2} />
                                                <Text size="small" style={{ fontWeight: 600 }}>Insert filter value</Text>
                                            </Box>
                                            {activeElement.useFilterValue && (
                                                <Box marginTop={2}>
                                                    <Text size="xsmall" textColor="light" marginBottom={2}>
                                                        {`Shows the value from the top filter${topFilterField ? ` on ${topFilterField.name}` : ' (set a field in the top filter)'}, then the appended text — e.g. "Danny" + "Roster" = "Danny Roster". The element's own text is ignored while this is on.`}
                                                    </Text>
                                                    <Text size="small" marginBottom={1}>Default (when empty / nothing selected)</Text>
                                                    <Input
                                                        size="small"
                                                        width="100%"
                                                        placeholder="e.g. Hallwood"
                                                        value={activeElement.filterDefault || ''}
                                                        onChange={e => updateSelected({ filterDefault: e.target.value })}
                                                    />
                                                    <Text size="small" marginTop={2} marginBottom={1}>Append after value</Text>
                                                    <Input
                                                        size="small"
                                                        width="100%"
                                                        placeholder="e.g. Roster"
                                                        value={activeElement.filterSuffix || ''}
                                                        onChange={e => updateSelected({ filterSuffix: e.target.value })}
                                                    />
                                                </Box>
                                            )}
                                        </Box>
                                    )}

                                    {(activeElement.type === 'static' || (activeElement.type === 'field' && activeElement.displayMode === 'text')) && (
                                        <Box marginTop={2} padding={2} border="default" borderRadius="default" backgroundColor="white">
                                            <Box display="flex" justifyContent="space-between" alignItems="center" marginBottom={1}>
                                                <Text size="small" style={{ fontWeight: 600 }}>Find &amp; Replace</Text>
                                                <Button
                                                    size="small"
                                                    icon="plus"
                                                    onClick={() => {
                                                        const rules = Array.isArray(activeElement.replacements) ? activeElement.replacements : [];
                                                        updateSelected({ replacements: [...rules, { find: '', replace: '' }] });
                                                    }}
                                                >
                                                    Add rule
                                                </Button>
                                            </Box>
                                            {(activeElement.replacements || []).map((rule, i) => (
                                                <Box key={i} display="flex" alignItems="center" marginTop={1}>
                                                    <Box flex="1">
                                                        <Input
                                                            size="small"
                                                            width="100%"
                                                            placeholder="Find"
                                                            value={rule.find || ''}
                                                            onChange={e => {
                                                                const rules = [...(activeElement.replacements || [])];
                                                                rules[i] = { ...rules[i], find: e.target.value };
                                                                updateSelected({ replacements: rules });
                                                            }}
                                                        />
                                                    </Box>
                                                    <Text marginX={1} textColor="light">&rarr;</Text>
                                                    <Box flex="1">
                                                        <Input
                                                            size="small"
                                                            width="100%"
                                                            placeholder={"Replace (\\n = line break)"}
                                                            value={rule.replace || ''}
                                                            onChange={e => {
                                                                const rules = [...(activeElement.replacements || [])];
                                                                rules[i] = { ...rules[i], replace: e.target.value };
                                                                updateSelected({ replacements: rules });
                                                            }}
                                                        />
                                                    </Box>
                                                    <Button
                                                        size="small"
                                                        variant="danger"
                                                        icon="trash"
                                                        marginLeft={1}
                                                        aria-label="Remove rule"
                                                        onClick={() => {
                                                            const rules = (activeElement.replacements || []).filter((_, j) => j !== i);
                                                            updateSelected({ replacements: rules });
                                                        }}
                                                    />
                                                </Box>
                                            ))}
                                            <Text size="xsmall" textColor="light" marginTop={1}>
                                                {"Replaces text live for every record, top to bottom. Type \\n for a line break (also works in Find)."}
                                            </Text>
                                        </Box>
                                    )}

                                    <Box marginTop={2} display="flex" alignItems="center">
                                        <Label marginRight={2}>Bold</Label>
                                        <Switch 
                                            value={activeElement.style.fontWeight === 'bold'}
                                            onChange={val => updateSelectedStyle('fontWeight', val ? 'bold' : 'normal')}
                                        />
                                    </Box>

                                    <Box marginTop={2}>
                                        <Label>Font Family</Label>
                                        <Select 
                                            options={FONT_OPTIONS}
                                            value={activeElement.style.fontFamily}
                                            onChange={val => updateSelectedStyle('fontFamily', val)}
                                        />
                                    </Box>

                                    {/* Text alignment inside the box (left/center/right) — any text node, incl. nested */}
                                    {(activeElement.type === 'static' || (activeElement.type === 'field' && activeElement.displayMode === 'text')) && (
                                        <Box marginTop={2}>
                                            <Text size="xsmall" textColor="light" marginBottom={1}>Text align</Text>
                                            <Box display="flex" gap={1}>
                                                <Button size="small" variant={(!activeElement.style.textAlign || activeElement.style.textAlign === 'left') ? 'primary' : 'default'} onClick={() => updateSelectedStyle('textAlign', 'left')}>Left</Button>
                                                <Button size="small" variant={activeElement.style.textAlign === 'center' ? 'primary' : 'default'} onClick={() => updateSelectedStyle('textAlign', 'center')}>Center</Button>
                                                <Button size="small" variant={activeElement.style.textAlign === 'right' ? 'primary' : 'default'} onClick={() => updateSelectedStyle('textAlign', 'right')}>Right</Button>
                                            </Box>
                                        </Box>
                                    )}

                                    {/* Only show alignment if it's a root element, stack children align via flex */}
                                    {!selectedStackChildId && (
                                        <Box marginTop={2}>
                                            <Text size="xsmall" textColor="light" marginBottom={1}>Position on page</Text>
                                            <Box display="flex" gap={2}>
                                                <Button size="small" onClick={() => handleAlign('left')}>Left</Button>
                                                <Button size="small" onClick={() => handleAlign('center')}>Center</Button>
                                                <Button size="small" onClick={() => handleAlign('right')}>Right</Button>
                                            </Box>
                                        </Box>
                                    )}
                                    
                                    <Box marginTop={2}>
                                        <Label>Border</Label>
                                        <Box display="flex" gap={2}>
                                            <Select 
                                                options={[
                                                    {value: '0px', label: 'None'},
                                                    {value: '1px', label: 'Thin'},
                                                    {value: '3px', label: 'Thick'},
                                                ]}
                                                value={activeElement.style.borderWidth}
                                                onChange={val => updateSelectedStyle('borderWidth', val)}
                                            />
                                            <Input 
                                                type="color" 
                                                value={activeElement.style.borderColor}
                                                onChange={e => updateSelectedStyle('borderColor', e.target.value)}
                                                style={{cursor:'pointer', height: '32px'}}
                                            />
                                        </Box>
                                    </Box>
                                </>
                            )}
                        </>
                    )}
                </Box>
                
                <Box padding={3} borderTop="thick" backgroundColor="white">
                     <Button variant="danger" icon="trash" onClick={resetCanvas} width="100%">Clear Canvas</Button>
                </Box>
            </Box>

            {/* --- MAIN AREA --- */}
            <Box flex="1" display="flex" flexDirection="column" backgroundColor="#e0e0e0">
                {/* TOOLBAR */}
                <Box padding={2} backgroundColor="white" borderBottom="thick" display="flex" flexWrap="wrap" alignItems="center" gap={2}>
                    <Heading size="small">Designer</Heading>

                    <Box display="flex" gap={1}>
                        <Tooltip content="Undo (Ctrl/Cmd+Z)">
                            <Button size="small" variant="secondary" icon="undo" aria-label="Undo"
                                onClick={undo} disabled={historyRef.current.past.length === 0} />
                        </Tooltip>
                        <Tooltip content="Redo (Ctrl/Cmd+Shift+Z)">
                            <Button size="small" variant="secondary" icon="redo" aria-label="Redo"
                                onClick={redo} disabled={historyRef.current.future.length === 0} />
                        </Tooltip>
                    </Box>
                    
                    <Box width="1px" height="20px" backgroundColor="lightGray2" marginX={2} />
                    
                    <Select 
                        options={base.tables.map(t => ({value: t.id, label: t.name}))}
                        value={selectedTableId}
                        onChange={id => setSelectedTableId(id)}
                        width="180px"
                    />

                    {/* SORT SECTION — sort by any field, incl. artist name */}
                    <Box display="flex" alignItems="center" gap={1} border="default" borderRadius="default" padding={1} backgroundColor="white">
                        <Icon name="sort" size={12} textColor="light" />
                        <Box width="130px">
                            <FieldPicker
                                table={table}
                                field={sortField}
                                onChange={f => setSortFieldId(f ? f.id : null)}
                                placeholder="Sort by..."
                                size="small"
                            />
                        </Box>
                        <Tooltip content={sortDirection === 'asc' ? 'Ascending (A→Z, 0→9)' : 'Descending (Z→A, 9→0)'}>
                            <Button
                                size="small"
                                variant="secondary"
                                icon={sortDirection === 'asc' ? 'chevronUp' : 'chevronDown'}
                                onClick={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')}
                                disabled={!sortFieldId}
                                aria-label="Toggle sort direction"
                            />
                        </Tooltip>
                        {sortFieldId && (
                            <Button
                                size="small"
                                variant="secondary"
                                icon="x"
                                onClick={() => setSortFieldId(null)}
                                aria-label="Clear sort"
                            />
                        )}
                    </Box>

                    {/* MULTI-FIELD FILTER SECTION */}
                    <Box display="flex" flexDirection="column" gap={1}>
                        {filters.map(f => (
                            <Box key={f.id} display="flex" alignItems="center" gap={1} border="default" borderRadius="default" padding={1} backgroundColor="white">
                                <Icon name="filter" size={12} textColor="light" />
                                <Box width="130px">
                                    <FieldPicker
                                        table={table}
                                        field={f.fieldId ? table.getFieldByIdIfExists(f.fieldId) : null}
                                        onChange={field => updateFilter(f.id, { fieldId: field ? field.id : null })}
                                        placeholder="Field..."
                                        size="small"
                                    />
                                </Box>
                                <Input
                                    value={f.keyword}
                                    onChange={e => updateFilter(f.id, { keyword: e.target.value })}
                                    placeholder="Value..."
                                    width="110px"
                                    size="small"
                                />
                                <Button icon="x" size="small" variant="secondary" onClick={() => removeFilter(f.id)} aria-label="Remove filter" />
                            </Box>
                        ))}
                        <Box display="flex" gap={1}>
                            <Button size="small" icon="plus" onClick={addFilter}>Add Filter</Button>
                            {filters.length > 0 && (
                                <Button size="small" variant="secondary" onClick={clearAllFilters}>Clear All</Button>
                            )}
                            {topFilterField && (
                                <Button
                                    size="small"
                                    variant="default"
                                    icon="download"
                                    disabled={isExporting}
                                    onClick={exportPerFilterValue}
                                >
                                    Export per {topFilterField.name} value
                                </Button>
                            )}
                        </Box>
                    </Box>

                    <Box width="1px" height="20px" backgroundColor="lightGray2" marginX={2} />
                    
                    {/* NAVIGATION & SEARCH SECTION */}
                    <Box display="flex" alignItems="center" gap={1}>
                        <Button 
                            icon="chevronLeft" 
                            onClick={() => setRecordIndex(Math.max(0, recordIndex - 1))}
                            disabled={recordIndex === 0} 
                            size="small"
                        />
                        <Text width="100px" textAlign="center" size="small">
                            {filteredRecords.length > 0 ? `${recordIndex + 1} / ${filteredRecords.length}` : "0 / 0"}
                        </Text>
                        <Button 
                            icon="chevronRight" 
                            onClick={() => setRecordIndex(Math.min(filteredRecords.length - 1, recordIndex + 1))}
                            disabled={recordIndex >= filteredRecords.length - 1} 
                            size="small"
                        />
                        <Input 
                            placeholder="Jump to..."
                            value={searchName}
                            onChange={e => handleSearchJump(e.target.value)}
                            width="120px"
                            size="small"
                            marginLeft={1}
                        />
                    </Box>

                    <Box flex="1" />
                    
                    {exportProgress && <Text textColor="light" marginRight={2}>{exportProgress}</Text>}
                    
                    <Button 
                        variant="primary" 
                        onClick={generatePDF} 
                        disabled={isExporting || !currentRecord}
                        icon="download"
                        marginRight={1}
                    >
                        Export Single
                    </Button>
                    <Button 
                        variant="primary" 
                        onClick={generateBulkPDF} 
                        disabled={isExporting || filteredRecords.length === 0}
                    >
                        Export All ({filteredRecords.length})
                    </Button>

                    <Box width="1px" height="20px" backgroundColor="lightGray2" marginX={1} />

                    <Button
                        icon="personalAuto"
                        variant="secondary"
                        onClick={() => setManagerPanelOpen(true)}
                    >
                        My Clients
                    </Button>
                </Box>

                {/* CANVAS WRAPPER */}
                <Box flex="1" overflow="auto" display="flex" justifyContent="center" padding={5}>
                    <div 
                        ref={pageRef}
                        id="print-container"
                        onClick={() => { setSelectedElementId(null); setSelectedChildPath([]); setSelectedIds([]); }}
                        style={{
                            ...getPageBackgroundStyle(),
                            width: pageStyle.width,
                            height: pageStyle.height,
                            minWidth: pageStyle.width, 
                            minHeight: pageStyle.height, 
                            position: 'relative',
                            boxShadow: '0 4px 15px rgba(0,0,0,0.15)',
                            transition: 'all 0.2s',
                            overflow: 'hidden', 
                            flexShrink: 0 
                        }}
                    >
                        {/* GUIDES OVERLAY */}
                        {guides.map((g, i) => (
                            <div 
                                key={i}
                                style={{
                                    position: 'absolute',
                                    backgroundColor: '#ff00ff',
                                    zIndex: 999,
                                    left: g.type === 'vertical' ? g.pos : 0,
                                    top: g.type === 'horizontal' ? g.pos : 0,
                                    width: g.type === 'vertical' ? '1px' : '100%',
                                    height: g.type === 'vertical' ? '100%' : '1px',
                                }}
                            />
                        ))}

                        {elements.map(el => {
                            const isSelected = selectedIds.includes(el.id) && !selectedStackChildId && !isExporting;
                            const isPrimary = selectedElementId === el.id;
                            const isDropTarget = dropTargetStackId === el.id && !isExporting;
                            const isDragging = draggingState && draggingState.id === el.id;
                            const gdPos = groupDrag && groupDrag[el.id];
                            const visualX = gdPos ? gdPos.x : (isDragging ? draggingState.x : el.x);
                            const visualY = gdPos ? gdPos.y : (isDragging ? draggingState.y : el.y);
                            const visualWidth = (resizingState && resizingState.id === el.id) ? resizingState.currentW : (el.width || 200);
                            const visualHeight = (resizingState && resizingState.id === el.id) ? resizingState.currentH : (el.height || 40);
                            const showResize = isSelected && selectedIds.length === 1 && isPrimary;

                            // --- CONTENT RENDERING LOGIC ---
                            let content = null;
                            
                            // 1. STACKS (Dynamic Row/Col) — recursive so stacks can nest.
                            if (el.type === 'stack') {
                                content = renderStackNode(el, el.id, []);
                            } else {
                                content = renderElementContent(el);
                            }

                            const nodeRef = getNodeRef(el.id);

                            return (
                                <Draggable
                                    key={el.id}
                                    nodeRef={nodeRef}
                                    position={{x: visualX, y: visualY}}
                                    onStart={(e, data) => handleDragStart(e, data, el.id)}
                                    onDrag={(e, data) => handleDrag(e, data, el.id)}
                                    onStop={(e, data) => handleDragStop(e, data, el.id)}
                                    bounds="parent"
                                    // FIX: Only disable dragging on the element whose child is selected,
                                    // not globally on all elements. This lets other elements still be moved.
                                    disabled={selectedStackChildId !== null && el.id === selectedElementId} 
                                >
                                    <div
                                        ref={nodeRef}
                                        style={{
                                            ...el.style,
                                            width: visualWidth,
                                            height: visualHeight,
                                            position: 'absolute',
                                            cursor: 'move',
                                            // Real element border only (0px = none). Selection is shown with
                                            // an OUTLINE, which sits outside the box and adds no size — so a
                                            // 1px line stays 1px instead of being inflated by a 1px border.
                                            border: (el.style.borderWidth && el.style.borderWidth !== '0px')
                                                ? `${el.style.borderWidth} ${el.style.borderStyle} ${el.style.borderColor}` : 'none',
                                            outline: isDropTarget ? '2px solid #17a34a' : (isSelected ? (isPrimary ? '1px dashed #2d7ff9' : '1px dashed #9ec5fe') : 'none'),
                                            outlineOffset: '1px',
                                            boxShadow: isDropTarget ? 'inset 0 0 0 9999px rgba(23,163,74,0.12)' : undefined,
                                            boxSizing: 'border-box',
                                            transform: 'translateZ(0)',
                                        }}
                                        onClick={(e) => { 
                                            e.stopPropagation(); 
                                            setSelectedChildPath([]); 
                                            setEditMode('elements'); 
                                            const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                                            if (additive) {
                                                setSelectedIds(prev => {
                                                    const has = prev.includes(el.id);
                                                    const next = has ? prev.filter(i => i !== el.id) : [...prev, el.id];
                                                    setSelectedElementId(next.length ? (has ? next[next.length - 1] : el.id) : null);
                                                    return next;
                                                });
                                            } else {
                                                setSelectedElementId(el.id);
                                                setSelectedIds([el.id]);
                                            }
                                        }}
                                    >
                                        {content}
                                        
                                        {showResize && (
                                            <div 
                                                className="resize-handle"
                                                style={{
                                                    width: '10px', height: '10px', backgroundColor: '#2d7ff9',
                                                    position: 'absolute', right: 0, bottom: 0, cursor: 'nwse-resize',
                                                    zIndex: 10, borderTopLeftRadius: '2px'
                                                }}
                                                onMouseDown={(e) => startResizing(e, el.id, visualWidth, visualHeight)}
                                            />
                                        )}
                                    </div>
                                </Draggable>
                            );
                        })}
                    </div>
                </Box>
            </Box>

            {/* ── MANAGER CLIENT EDITOR PANEL ───────────────────────────────── */}
            {managerPanelOpen && (
                <Box
                    position="fixed"
                    top="0" right="0" bottom="0"
                    width="400px"
                    backgroundColor="white"
                    borderLeft="thick"
                    display="flex"
                    flexDirection="column"
                    style={{ zIndex: 1000, boxShadow: '-4px 0 20px rgba(0,0,0,0.15)' }}
                >
                    {/* Panel header */}
                    <Box padding={3} borderBottom="thick" display="flex" justifyContent="space-between" alignItems="center">
                        <Box>
                            <Heading size="small">My Clients</Heading>
                            <Text size="xsmall" textColor="light">
                                Filtering for: <strong>{managerName || 'not set'}</strong>
                            </Text>
                        </Box>
                        <Button icon="x" variant="secondary" onClick={() => setManagerPanelOpen(false)} aria-label="Close panel" />
                    </Box>

                    {/* Field configuration */}
                    <Box padding={3} borderBottom="default" backgroundColor="#f9f9f9">
                        <Text size="xsmall" textColor="light" marginBottom={2}>
                            Configure your name and which fields to use:
                        </Text>
                        <Box marginBottom={2}>
                            <Label>Your Name (must match the manager field value)</Label>
                            <Input
                                value={managerName}
                                onChange={e => saveManagerName(e.target.value)}
                                placeholder="e.g. Jane Smith"
                            />
                        </Box>
                        <Box marginBottom={2}>
                            <Label>Manager Field (contains your name)</Label>
                            <FieldPicker
                                table={table}
                                field={managerFieldId ? table.getFieldByIdIfExists(managerFieldId) : null}
                                onChange={f => setManagerFieldId(f ? f.id : null)}
                                placeholder="Pick manager field..."
                            />
                        </Box>
                        <Box>
                            <Label>Clients Field (editable text/notes)</Label>
                            <FieldPicker
                                table={table}
                                field={clientsFieldId ? table.getFieldByIdIfExists(clientsFieldId) : null}
                                onChange={f => setClientsFieldId(f ? f.id : null)}
                                placeholder="Pick clients field..."
                            />
                        </Box>
                    </Box>

                    {/* Records list */}
                    <Box flex="1" overflowY="auto" padding={3}>
                        {!managerFieldId || !clientsFieldId ? (
                            <Text textColor="light" textAlign="center" marginTop={4}>
                                Select both fields above to see your records.
                            </Text>
                        ) : myManagerRecords.length === 0 ? (
                            <Box textAlign="center" marginTop={4}>
                                <Text textColor="light">No records found where</Text>
                                <Text textColor="light">the manager field contains</Text>
                                <Text fontWeight="bold">"{managerName || '(no name set)'}"</Text>
                            </Box>
                        ) : (
                            myManagerRecords.map(record => {
                                const isEditing = managerEditingId === record.id;
                                const clientVal = safeGetCellValueAsString(record, table, clientsFieldId);
                                return (
                                    <Box
                                        key={record.id}
                                        padding={2}
                                        marginBottom={2}
                                        border="default"
                                        borderRadius="default"
                                        backgroundColor={isEditing ? '#f0f7ff' : 'white'}
                                        style={{ borderLeft: `4px solid ${isEditing ? '#2d7ff9' : '#e0e0e0'}` }}
                                    >
                                        <Text fontWeight="bold" marginBottom={1}>{record.name || '(Unnamed)'}</Text>
                                        {isEditing ? (
                                            <Box>
                                                <Input
                                                    value={managerEditValue}
                                                    onChange={e => setManagerEditValue(e.target.value)}
                                                    placeholder="Enter client list..."
                                                    style={{ width: '100%', marginBottom: '8px', minHeight: '60px' }}
                                                />
                                                <Box display="flex" gap={1} marginTop={1}>
                                                    <Button
                                                        size="small"
                                                        variant="primary"
                                                        onClick={() => saveClientEdit(record)}
                                                        disabled={managerSaving}
                                                    >
                                                        {managerSaving ? 'Saving...' : 'Save'}
                                                    </Button>
                                                    <Button
                                                        size="small"
                                                        variant="secondary"
                                                        onClick={() => setManagerEditingId(null)}
                                                        disabled={managerSaving}
                                                    >
                                                        Cancel
                                                    </Button>
                                                </Box>
                                            </Box>
                                        ) : (
                                            <Box display="flex" justifyContent="space-between" alignItems="flex-start">
                                                <Text size="small" textColor={clientVal ? 'default' : 'light'} style={{ flex: 1, marginRight: '8px', whiteSpace: 'pre-wrap' }}>
                                                    {clientVal || 'No clients listed'}
                                                </Text>
                                                <Button
                                                    size="small"
                                                    icon="edit"
                                                    variant="secondary"
                                                    onClick={() => startEditingClient(record)}
                                                >
                                                    Edit
                                                </Button>
                                            </Box>
                                        )}
                                    </Box>
                                );
                            })
                        )}
                    </Box>

                    {/* Panel footer */}
                    <Box padding={3} borderTop="thick" backgroundColor="#f9f9f9">
                        <Text size="xsmall" textColor="light">
                            {myManagerRecords.length} record{myManagerRecords.length !== 1 ? 's' : ''} assigned to you
                            {activeFilters.length > 0 ? ' (active filters apply)' : ''}.
                            Only you can see this view — other managers see only their own records.
                        </Text>
                    </Box>
                </Box>
            )}
        </Box>
    );
}

initializeBlock(() => (
    <ErrorBoundary>
        <UpgradedPageDesigner />
    </ErrorBoundary>
));