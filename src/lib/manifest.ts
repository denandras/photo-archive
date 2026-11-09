import fs from 'fs';
import path from 'path';

export interface Photo {
  key: string;
  name: string;
  time: string;
  src?: string;
  width?: number;
  height?: number;
}

export interface Manifest {
  years: Record<string, Record<string, Photo[]>>;
}

export interface YearFile {
  days: Record<string, Photo[]>;
}

function readYearFile(year: string): YearFile {
  const filePath = path.join(process.cwd(), 'public', 'years', `${year}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as YearFile;
}

export type YearIndex = { [year: string]: { days: number; photos: number } };

export async function loadYearIndex(): Promise<YearIndex> {
  const filePath = path.join(process.cwd(), 'public', 'manifest.index.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as YearIndex;
}

// Same shape as the old monolithic manifest loader, but sources each year
// from its own static file (public/years/<year>.json).
export async function loadManifest() {
  const index = await loadYearIndex();
  const years: Record<string, Record<string, Photo[]>> = {};
  for (const year of Object.keys(index)) {
    try {
      years[year] = readYearFile(year).days;
    } catch {
      // file missing/corrupt -> treat year as empty
    }
  }
  return { years };
}
