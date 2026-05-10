import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'ph',
    standalone: false
})
export class ph implements PipeTransform {

  transform(value: string) {
    let x = `url(${value})`
    return x.replace('.svg', '_ph.svg')

  }

}
