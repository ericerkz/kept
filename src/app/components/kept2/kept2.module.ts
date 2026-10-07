import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { VaultAccessComponent } from './vault-access/vault-access.component';

const routes: Routes = [
  { path: 'vault', component: VaultAccessComponent },
  { path: '', redirectTo: 'vault', pathMatch: 'full' }
];

@NgModule({
  declarations: [VaultAccessComponent],
  imports: [
    CommonModule,
    FormsModule,
    RouterModule.forChild(routes)
  ]
})
export class Kept2Module {}
