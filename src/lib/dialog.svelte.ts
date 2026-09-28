export const dialog = $state<{
  title: string;
  message: string;
  choices: string[];
  resolve: ((value: string) => void) | null;
}>({ title: '', message: '', choices: [], resolve: null });
export function ask(
  title: string,
  message: string,
  choices: string[],
): Promise<string> {
  if (dialog.resolve) dialog.resolve('Cancel');
  return new Promise((resolve) =>
    Object.assign(dialog, { title, message, choices, resolve }),
  );
}
export function answer(value: string) {
  const resolve = dialog.resolve;
  dialog.resolve = null;
  resolve?.(value);
}
