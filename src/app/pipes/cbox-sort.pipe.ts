import { Pipe, PipeTransform } from '@angular/core';
import { CheckboxI } from '../interfaces/notes';

@Pipe({
    name: 'cboxSort',
    standalone: false
})
export class CboxSortPipe implements PipeTransform {

  transform(object: CheckboxI[]): CheckboxI[] {
    return [...object].sort((x, y) => Number(x.done) - Number(y.done))
  }
}
