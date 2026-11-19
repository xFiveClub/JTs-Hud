import { app } from 'electron'

// Must be the FIRST import of the main entry: the SQLite module reads userData at import
// time. Lets end-to-end tests run against a throwaway profile instead of the real database.
if (process.env.JTS_USER_DATA_DIR) {
  app.setPath('userData', process.env.JTS_USER_DATA_DIR)
}
