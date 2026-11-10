/** The module each scriptc build writes as natives.ts: the app's <script lang="c"> exports. */
export declare const native_names: string[];
export declare function call_native(name: string, args: unknown[]): unknown;
