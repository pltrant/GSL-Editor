import * as path from 'path'

export const scriptNumberFromFileName = (fileName: string): string => {
    return path.basename(fileName).replace(/\D+/g,'').replace(/^0+/,'')
}