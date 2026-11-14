import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { provideRouter, Router, RouterModule } from '@angular/router';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { provideTranslateService, TranslatePipe } from '@ngx-translate/core';
import { NavComponent } from './sidenav.component';
import { CatalogReorderDirective } from './catalog-reorder.directive';
import { SharedService } from '../../services/shared.service';
import { AuthService } from '../../services/auth.service';
import { BindersService } from '../../services/binders.service';
import { UiPluralPipe, UiTextPipe } from '../../i18n/ui-text.pipe';

@Component({ template: '' })
class RouteTargetComponent {}

describe('Sidebar active Binder and Label', () => {
  const binders = ['Auta', 'Dům a zahrada', 'České poznámky', 'Auta další', 'Znaky / ? # % +'];
  const labels = ['Úkoly doma', 'Běžné', 'Běžné další', 'Znaky / ? # % +'];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [NavComponent, CatalogReorderDirective, UiTextPipe, UiPluralPipe],
      imports: [CommonModule, RouterModule, TranslatePipe],
      providers: [
        provideTranslateService(),
        provideRouter([
          { path: 'binder/:name', component: RouteTargetComponent },
          { path: 'label/:name', component: RouteTargetComponent },
          { path: 'binder/:name/child', component: RouteTargetComponent },
          { path: 'label/:name/child', component: RouteTargetComponent }
        ]),
        { provide: SharedService, useValue: {
          initPwa: () => {},
          binder: { list: binders.map(name => ({ name })) },
          sharedBinders: [],
          label: { list: labels.map((name, id) => ({ id, name })) },
          closeSideBar: new Subject(),
          closeSideBarIfOpen: new Subject(),
          sideBarCollapsed: new BehaviorSubject(false),
          showInstallButton: of(false)
        } },
        { provide: AuthService, useValue: { isAdmin: false } },
        { provide: BindersService, useValue: { sync: { partition: 'test' } } }
      ]
    }).compileComponents();
  });

  for (const [section, names] of [['binder', binders], ['label', labels]] as const) {
    for (const name of names) {
      it(`highlights only ${section} ${name} after encoded navigation`, async () => {
        const fixture = TestBed.createComponent(NavComponent);
        const router = TestBed.inject(Router);
        fixture.detectChanges();
        const url = router.serializeUrl(router.createUrlTree(['/' + section, name]));
        await router.navigateByUrl(url);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const active = fixture.nativeElement.querySelectorAll('.is-binder.active, .is-label.active');
        expect(active.length).toBe(1);
        expect(active[0].getAttribute('title')).toBe(name);
        expect(active[0].classList.contains('is-' + section)).toBeTrue();

        await router.navigateByUrl(url + '/child');
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.is-binder.active, .is-label.active').length).toBe(0);
        fixture.destroy();
      });
    }
  }
});
