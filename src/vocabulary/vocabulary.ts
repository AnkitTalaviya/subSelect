import type { SavedWord } from '@shared/types';
import { getSettings } from '@shared/storage';
import { deleteWord, getVocabulary, queryVocabulary, type SortOrder } from './VocabularyManager';
import { exportFilename, serialize, type ExportFormat } from './VocabularyExporter';

/**
 * Vocabulary dashboard (§21, §22).
 *
 * An extension page, which is what makes export possible at all: a content script cannot
 * start a download, but a blob URL from an extension page can.
 *
 * Everything here reads `chrome.storage.local` directly. There is no backend to page
 * against and no request to make.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`vocabulary markup is missing #${id}`);
  return node as T;
}

const list = el<HTMLUListElement>('words');
const empty = el<HTMLParagraphElement>('empty');
const countLine = el<HTMLParagraphElement>('count');
const search = el<HTMLInputElement>('search');
const sort = el<HTMLSelectElement>('sort');

let words: SavedWord[] = [];

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function render(): void {
  const visible = queryVocabulary(words, search.value, sort.value as SortOrder);

  countLine.textContent =
    words.length === 0
      ? 'No saved words yet'
      : visible.length === words.length
        ? `${words.length} saved ${words.length === 1 ? 'word' : 'words'}`
        : `${visible.length} of ${words.length} words`;

  if (visible.length === 0) {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent =
      words.length === 0
        ? 'Select a word while watching a video and choose Save. It will appear here.'
        : 'No saved words match that search.';
    return;
  }

  empty.hidden = true;
  list.replaceChildren(...visible.map(row));
}

function row(word: SavedWord): HTMLLIElement {
  const item = document.createElement('li');

  const body = document.createElement('div');
  body.className = 'word-body';

  const headword = document.createElement('p');
  headword.className = 'headword';
  headword.textContent = word.word;
  body.appendChild(headword);

  if (word.translation) {
    const translation = document.createElement('p');
    translation.className = 'translation';
    translation.textContent = word.translation;
    body.appendChild(translation);
  }

  if (word.context && word.context !== word.word) {
    const context = document.createElement('p');
    context.className = 'context';
    context.textContent = word.context;
    body.appendChild(context);
  }

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    dateFormat.format(new Date(word.createdAt)),
    word.sourceLanguage?.toUpperCase(),
    word.website,
  ]
    .filter(Boolean)
    .join(' · ');
  body.appendChild(meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete';
  remove.textContent = 'Delete';
  remove.setAttribute('aria-label', `Delete ${word.word}`);
  remove.addEventListener('click', () => {
    void deleteWord(word.id).then(async () => {
      words = await getVocabulary();
      render();
    });
  });

  item.append(body, remove);
  return item;
}

/**
 * Writes an export file.
 *
 * Built from a blob in this page, so the data never leaves the device to become a file.
 * The object URL is revoked once the download has been handed to the browser.
 */
function download(format: ExportFormat): void {
  const visible = queryVocabulary(words, search.value, sort.value as SortOrder);
  const blob = new Blob([serialize(visible, format)], {
    type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFilename(format);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

search.addEventListener('input', render);
sort.addEventListener('change', render);
el<HTMLButtonElement>('export-csv').addEventListener('click', () => download('csv'));
el<HTMLButtonElement>('export-json').addEventListener('click', () => download('json'));

// Stay in step if a word is saved from a video while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.vocabulary) return;
  void getVocabulary().then((next) => {
    words = next;
    render();
  });
});

async function init(): Promise<void> {
  const settings = await getSettings();
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);

  words = await getVocabulary();
  render();
}

void init();
