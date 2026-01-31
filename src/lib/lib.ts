export type ValueOf<T> = T[keyof T]

export const toKebabCase = (str: string) =>
  str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .replace(/\./g, '-')
    .toLowerCase()
