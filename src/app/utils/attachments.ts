// Match the server attachment policy, including document providers that only
// return application/octet-stream for a supported filename.
const TYPES: Record<string,string> = {
  pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt:'text/plain',csv:'text/csv',md:'text/markdown',json:'application/json',xml:'application/xml',
  zip:'application/zip',rar:'application/vnd.rar','7z':'application/x-7z-compressed',gz:'application/gzip',tar:'application/x-tar',
  odt:'application/vnd.oasis.opendocument.text',ods:'application/vnd.oasis.opendocument.spreadsheet',odp:'application/vnd.oasis.opendocument.presentation'
};
const ALIASES: Record<string,string> = {'application/x-zip-compressed':'application/zip','multipart/x-zip':'application/zip','application/x-rar-compressed':'application/vnd.rar','application/x-gzip':'application/gzip'};
export function attachmentMimeType(filename: string, type = '') {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const expected = TYPES[extension];
  const supplied = ALIASES[type.toLowerCase()] || type.toLowerCase();
  if (!expected || (supplied && supplied !== 'application/octet-stream' && supplied !== 'text/plain' && supplied !== expected)) throw new Error('Choose a supported document, text file or archive.');
  return supplied === 'text/plain' ? supplied : expected;
}
