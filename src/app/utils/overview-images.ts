export interface OverviewImage {
  src: string;
  alt: string;
  index: number;
  drawing?: string;
}

export interface OverviewImageGroup {
  type: 'images';
  value: string;
  images: OverviewImage[];
}
