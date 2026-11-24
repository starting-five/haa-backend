// A place the patient picked is stored as one text column plus eight detail
// columns per use — incident_*, residence_*, treatment_area_* — rather than as
// JSON, so the admin and lawyer views can read them without parsing. These two
// functions are the only translation between that layout and the
// LocationDetails shape the frontend sends and reads back.

export type LocationPrefix = "incident" | "residence" | "treatment_area";

export interface LocationDetailsInput {
  latitude?: number;
  longitude?: number;
  placeId?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source?: string;
  precision?: string;
}

export interface StoredLocationDetails {
  text: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source: string;
  precision: string;
}

export function locationColumns(details?: LocationDetailsInput | null, prefix?: LocationPrefix) {
  if (!prefix) return {};
  return {
    [`${prefix}_lat`]: details?.latitude ?? null,
    [`${prefix}_lng`]: details?.longitude ?? null,
    [`${prefix}_place_id`]: details?.placeId ?? null,
    [`${prefix}_city`]: details?.city ?? null,
    [`${prefix}_state`]: details?.state ?? null,
    [`${prefix}_postal_code`]: details?.postalCode ?? null,
    [`${prefix}_source`]: details?.source ?? null,
    [`${prefix}_precision`]: details?.precision ?? null,
  };
}

/** The column names locationDetailsFromRow reads, for a select list. */
export function locationColumnNames(prefix: LocationPrefix): string[] {
  return ["lat", "lng", "place_id", "city", "state", "postal_code", "source", "precision"].map(
    (column) => `${prefix}_${column}`
  );
}

/**
 * The details a row holds for one place, or null when it holds none. A place
 * stored before the detail columns existed — or typed by hand when Google was
 * unavailable without a source recorded — has no source, and the frontend
 * treats null as "pick the place again" rather than inventing a precision.
 */
export function locationDetailsFromRow(
  row: Record<string, unknown>,
  prefix: LocationPrefix,
  text: string | null | undefined
): StoredLocationDetails | null {
  const source = row[`${prefix}_source`];
  const precision = row[`${prefix}_precision`];
  if (!text || typeof source !== "string" || typeof precision !== "string") return null;

  const numberAt = (column: string) => {
    const value = row[`${prefix}_${column}`];
    if (typeof value === "number") return value;
    // numeric columns arrive as strings from PostgREST
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  };
  const stringAt = (column: string) => {
    const value = row[`${prefix}_${column}`];
    return typeof value === "string" && value ? value : undefined;
  };

  const latitude = numberAt("lat");
  const longitude = numberAt("lng");
  const placeId = stringAt("place_id");
  const city = stringAt("city");
  const state = stringAt("state");
  const postalCode = stringAt("postal_code");

  return {
    text,
    ...(latitude !== undefined && { latitude }),
    ...(longitude !== undefined && { longitude }),
    ...(placeId !== undefined && { placeId }),
    ...(city !== undefined && { city }),
    ...(state !== undefined && { state }),
    ...(postalCode !== undefined && { postalCode }),
    source,
    precision,
  };
}
